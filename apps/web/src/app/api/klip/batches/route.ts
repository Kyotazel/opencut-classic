import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { MAX_ZIP_BYTES } from "@/klip/batch-upload";
import { listZipEntries, saveBatchZip } from "@/klip/batch-store";
import { createBatch, resolveDefaultOwnerUserId } from "@/klip/batch-service";
import { dataRoot, UploadError } from "@/klip/upload";

/**
 * POST /api/klip/batches — catat batch, JANGAN kerjakan (Tahap 1).
 *
 * Menerima dua bentuk input (T1-1):
 *   - multipart/form-data dengan field "file"  -> dipakai UI
 *   - application/json { zip_url, template_id? } -> dipakai sistem lain
 *
 * Balasan 202 + batch_id; worker (Tahap 2) yang mengeksekusi.
 */

async function jobCountFor({ absPath }: { absPath: string }): Promise<string[]> {
	const entries = await listZipEntries({ absPath });
	return entries.map((e) => e.name);
}

/**
 * Pemilik batch (keputusan #6) berasal dari ENV: KLIP_OWNER_ID, atau APP_USER.
 * Tidak membaca tabel `users` — lihat catatan di klip/batch-service.ts.
 * Mengembalikan null kalau keduanya kosong, supaya caller menolak dengan
 * pesan jelas alih-alih menulis ownerUserId yang tidak berarti.
 */
function requireOwner(): string | null {
	return resolveDefaultOwnerUserId();
}

function noOwnerResponse() {
	return NextResponse.json(
		{ error: "No user exists yet; cannot assign a batch owner" },
		{ status: 409 },
	);
}

function errorResponse({ error }: { error: unknown }) {
	if (error instanceof UploadError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	console.error("POST /api/klip/batches failed", error);
	return NextResponse.json({ error: "Batch create failed" }, { status: 500 });
}

async function rejectUnusableZip({
	absPath,
	filename,
}: {
	absPath: string;
	filename: string;
}): Promise<string[]> {
	try {
		return await jobCountFor({ absPath });
	} catch (error) {
		if (error instanceof UploadError) {
			throw new UploadError(`${filename}: ${error.message}`, error.status);
		}
		throw error;
	}
}

export async function POST(request: NextRequest) {
	const contentType = request.headers.get("content-type") ?? "";

	if (contentType.includes("application/json")) {
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
		}
		const zipUrl = typeof body.zip_url === "string" ? body.zip_url.trim() : "";
		if (!zipUrl) {
			return NextResponse.json({ error: "zip_url is required" }, { status: 400 });
		}
		const templateId =
			typeof body.template_id === "string" && body.template_id.trim()
				? body.template_id.trim()
				: null;
		// Owner dicek setelah body valid, supaya request cacat tetap 400.
		const ownerUserId = requireOwner();
		if (!ownerUserId) return noOwnerResponse();
		// Ambil ZIP dari URL. Batas ukuran diperiksa dari header sebelum unduh
		// supaya URL besar tidak menghabiskan memori lebih dulu.
		let bytes: Buffer;
		try {
			const res = await fetch(zipUrl);
			if (!res.ok) {
				return NextResponse.json(
					{ error: `zip_url returned HTTP ${res.status}` },
					{ status: 400 },
				);
			}
			const declared = Number(res.headers.get("content-length") ?? "");
			if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) {
				return NextResponse.json(
					{ error: `zip_url too large (max ${MAX_ZIP_BYTES} bytes)` },
					{ status: 413 },
				);
			}
			bytes = Buffer.from(await res.arrayBuffer());
		} catch {
			return NextResponse.json({ error: "zip_url could not be fetched" }, { status: 400 });
		}
		if (bytes.length === 0) {
			return NextResponse.json({ error: "zip_url returned an empty body" }, { status: 400 });
		}
		if (bytes.length > MAX_ZIP_BYTES) {
			return NextResponse.json(
				{ error: `zip_url too large (max ${MAX_ZIP_BYTES} bytes)` },
				{ status: 413 },
			);
		}
		const filename = path.basename(new URL(zipUrl).pathname) || "batch.zip";
		if (!filename.toLowerCase().endsWith(".zip")) {
			return NextResponse.json({ error: "zip_url must point to a .zip" }, { status: 400 });
		}
		return await persist({ bytes, filename, templateId, source: "api", ownerUserId });
	}

	// multipart (UI)
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) {
		return NextResponse.json({ error: "file is required" }, { status: 400 });
	}
	if (!file.name.toLowerCase().endsWith(".zip")) {
		return NextResponse.json({ error: "Only .zip files are accepted" }, { status: 400 });
	}
	if (file.size === 0) {
		return NextResponse.json({ error: "file is empty" }, { status: 400 });
	}
	if (file.size > MAX_ZIP_BYTES) {
		return NextResponse.json(
			{ error: `zip too large (max ${MAX_ZIP_BYTES} bytes)` },
			{ status: 413 },
		);
	}
	const rawTemplate = form.get("templateId");
	const templateId =
		typeof rawTemplate === "string" && rawTemplate.trim() ? rawTemplate.trim() : null;
	const ownerUserId = requireOwner();
	if (!ownerUserId) return noOwnerResponse();
	return await persist({
		bytes: Buffer.from(await file.arrayBuffer()),
		filename: file.name,
		templateId,
		source: "upload",
		ownerUserId,
	});
}

async function persist({
	bytes,
	filename,
	templateId,
	source,
	ownerUserId,
}: {
	bytes: Buffer;
	filename: string;
	templateId: string | null;
	source: "upload" | "api";
	ownerUserId: string;
}) {
	const batchId = `b_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	let zipPath: string | null = null;
	try {
		// Simpan ke disk DULU, lalu baca daftar entri dari file itu (T1-4).
		zipPath = await saveBatchZip({ batchId, bytes });
		const absPath = path.join(dataRoot(), zipPath);
		const entryNames = await rejectUnusableZip({ absPath, filename });
		const created = await createBatch({
			input: {
				zipPath,
				zipBytes: bytes.length,
				entryNames,
				templateId,
				source,
				ownerUserId,
			},
		});
		return NextResponse.json(
			{
				batchId: created.id,
				status: "queued",
				jobCount: created.jobCount,
				templateId: created.templateId,
			},
			{ status: 202 },
		);
	} catch (error) {
		// Jangan tinggalkan ZIP yatim kalau batch gagal dicatat.
		if (zipPath) {
			const { unlink } = await import("node:fs/promises");
			await unlink(path.join(dataRoot(), zipPath)).catch(() => {});
		}
		return errorResponse({ error });
	}
}
