import path from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipBatches, klipBatchJobs } from "@/db";
import { dataRoot } from "@/klip/upload";
import { RENDER_DIR } from "@/klip/worker/extract";

/**
 * DELETE /api/klip/batches/[id] - hapus satu batch beserta berkasnya.
 *
 * Baris klip_batch_jobs ikut terhapus lewat ON DELETE CASCADE, tapi BERKAS di
 * disk tidak: ZIP-nya di batches/ dan hasil ekstraknya di batch-source/.
 * Keduanya dibersihkan di sini supaya menghapus batch benar-benar membebaskan
 * ruang - ZIP bisa ratusan MB dan folder ekstraknya sama besarnya lagi.
 *
 * YANG SENGAJA TIDAK DIHAPUS: klip_projects dan hasil render. Kolom
 * klip_projects.batchId bukan foreign key, jadi project tetap ada - dan itu
 * memang yang diinginkan: video yang sudah dirender (dan mungkin sudah
 * tayang di Instagram) tidak boleh hilang hanya karena baris antriannya
 * dibersihkan. Baris batch adalah catatan pekerjaan, bukan pemilik hasilnya.
 *
 * Idempoten: menghapus batch yang sudah tidak ada tetap membalas 200, supaya
 * klik dua kali atau dua tab tidak memunculkan error yang membingungkan.
 */
export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	if (!id) {
		return NextResponse.json({ error: "id batch wajib diisi" }, { status: 400 });
	}

	const rows = await db
		.select({ id: klipBatches.id, zipPath: klipBatches.zipPath })
		.from(klipBatches)
		.where(eq(klipBatches.id, id))
		.limit(1);
	const batch = rows[0];
	if (!batch) {
		// Sudah tidak ada = hasil yang diinginkan pemanggil.
		return NextResponse.json({ deleted: false, alreadyGone: true });
	}

	// Job dihitung SEBELUM dihapus, supaya balasannya bisa menyebut jumlahnya.
	const jobs = await db
		.select({ id: klipBatchJobs.id })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, id));

	// Baris dulu, berkas kemudian: kalau menghapus berkas gagal, barisnya sudah
	// tidak ada sehingga tidak ada batch "hantu" yang menunjuk ZIP hilang.
	await db.delete(klipBatches).where(eq(klipBatches.id, id));

	// Berkas dibersihkan best-effort. Kegagalannya TIDAK membatalkan penghapusan:
	// barisnya sudah hilang, jadi melaporkan error justru menyesatkan.
	let bytesFreed = 0;
	const targets = [
		batch.zipPath ? path.join(dataRoot(), batch.zipPath) : null,
		path.join(dataRoot(), RENDER_DIR, id),
	].filter((p): p is string => Boolean(p));

	for (const target of targets) {
		try {
			bytesFreed += await ukuran(target);
			await rm(target, { recursive: true, force: true });
		} catch (error) {
			console.warn(
				`gagal hapus ${target}: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	return NextResponse.json({
		deleted: true,
		batchId: id,
		jobs: jobs.length,
		bytesFreed,
	});
}

/**
 * Ukuran berkas atau folder, dalam byte. 0 kalau tidak ada.
 *
 * Dihitung SEBELUM menghapus, karena setelahnya sudah tidak ada yang bisa
 * diukur - dan angka ini yang dipakai untuk memberi tahu pengguna berapa ruang
 * yang dibebaskan.
 */
async function ukuran(target: string): Promise<number> {
	const info = await stat(target).catch(() => null);
	if (!info) return 0;
	if (info.isFile()) return info.size;
	if (!info.isDirectory()) return 0;
	let total = 0;
	for (const name of await readdir(target)) {
		total += await ukuran(path.join(target, name));
	}
	return total;
}
