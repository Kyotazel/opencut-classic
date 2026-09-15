import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches } from "@/db";
import { dataRoot } from "@/klip/upload";
import { pastikanAudioAac } from "@/klip/media-encode";

export const RENDERS_DIR = "renders";
/** Batas keras sama dengan batas unggah media. */
const MAX_RENDER_BYTES = 500 * 1024 * 1024;

/**
 * POST /api/klip/batches/[id]/rendered?job=<jobId>
 *
 * Menerima berkas MP4 hasil render Chromium dan menyimpannya ke disk.
 *
 * KENAPA LEWAT HTTP: Chromium berjalan di dalam browser dan tidak punya akses
 * ke disk server. Hasil render dikirim sebagai body mentah (ArrayBuffer) -
 * bukan multipart - supaya tidak ada penyalinan tambahan untuk berkas yang
 * bisa puluhan MB.
 *
 * Path disusun dari id job, bukan dari input klien, jadi tidak ada celah
 * traversal.
 */
// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const jobId = request.nextUrl.searchParams.get("job");
	if (!jobId) {
		return NextResponse.json({ error: "job wajib" }, { status: 400 });
	}

	const rows = await db
		.select({ id: klipBatchJobs.id })
		.from(klipBatchJobs)
		.where(and(eq(klipBatchJobs.id, jobId), eq(klipBatchJobs.batchId, id)))
		.limit(1);
	if (!rows[0]) {
		return NextResponse.json(
			{ error: "job tidak ada di batch ini" },
			{ status: 404 },
		);
	}

	let bytes: Buffer;
	try {
		bytes = Buffer.from(await request.arrayBuffer());
	} catch {
		return NextResponse.json({ error: "body tidak terbaca" }, { status: 400 });
	}
	if (bytes.length === 0) {
		return NextResponse.json({ error: "berkas kosong" }, { status: 400 });
	}
	if (bytes.length > MAX_RENDER_BYTES) {
		return NextResponse.json({ error: "berkas terlalu besar" }, { status: 413 });
	}

	// Sanitasi id job supaya tidak ada karakter path di nama berkas.
	const safeId = jobId.replace(/[^A-Za-z0-9_-]/g, "");
	const relPath = path.join(RENDERS_DIR, `${safeId}.mp4`);
	const absPath = path.join(dataRoot(), relPath);
	await mkdir(path.dirname(absPath), { recursive: true });
	await writeFile(absPath, bytes);

	// Audio diseragamkan ke AAC SEBELUM dicatat.
	//
	// Encoder AAC tidak tersedia di Chromium headless milik Playwright,
	// sehingga render menghasilkan MP4 ber-audio Opus - kombinasi non-standar
	// yang ditolak Meta ("Instagram gagal memproses video") walau kadang lolos.
	// Dilakukan di sini supaya SEMUA pembaca berkas ini - tombol unduh maupun
	// publish ke Instagram - mendapat MP4 yang standar.
	const normalisasi = await pastikanAudioAac({ absPath });
	if (normalisasi.diubah || normalisasi.keterangan.startsWith("gagal")) {
		console.log(`[rendered] audio ${jobId}: ${normalisasi.keterangan}`);
	}

	await db
		.update(klipBatchJobs)
		.set({ renderedPath: relPath, updatedAt: new Date() })
		.where(eq(klipBatchJobs.id, jobId));

	// Batch ditandai selesai penuh hanya kalau semua job sudah selesai;
	// penghitungannya dilakukan worker lewat refreshBatchCounters.
	const batch = await db
		.select({ id: klipBatches.id })
		.from(klipBatches)
		.where(eq(klipBatches.id, id))
		.limit(1);
	if (!batch[0]) {
		return NextResponse.json({ error: "batch tidak ada" }, { status: 404 });
	}

	return NextResponse.json({ ok: true, bytes: bytes.length, path: relPath });
}
