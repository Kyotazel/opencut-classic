import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { MAX_ZIP_BYTES } from "@/klip/batch-upload";
import { listZipEntries, saveBatchZip } from "@/klip/batch-store";
import { createBatch, getBatch, listBatchJobs, resolveDefaultOwnerUserId } from "@/klip/batch-service";
import { listBatches, summarizeJobs } from "@/klip/batch-query";
import { dataRoot, UploadError } from "@/klip/upload";
import { MAX_CAPTION_LENGTH } from "@/klip/ig-publish";
import { bacaStatusKuota } from "@/klip/ig-quota-status";
import { sendTelegram } from "@/klip/alerts";
import { pesanBatchDiterima } from "@/klip/worker/notify";
import {
	SIGNATURE_HEADER,
	signatureMatches,
	signatureRequired,
} from "@/klip/webhook-signature";

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

/**
 * GET /api/klip/batches — daftar batch terbaru + progres untuk tracking.
 *
 * Tanpa `id`: ringkasan semua batch. Dengan `?id=b_xxx`: batch itu plus
 * daftar job-nya, supaya bisa dilihat per video.
 */
export async function GET(request: NextRequest) {
	// Dibaca dari URL, bukan request.nextUrl, supaya jalur ini juga bisa diuji
	// dengan Request biasa (tanpa NextRequest penuh).
	const id = new URL(request.url).searchParams.get("id");
	try {
		if (id) {
			const batch = await getBatch({ id });
			if (!batch) {
				return NextResponse.json({ error: "Batch not found" }, { status: 404 });
			}
			const jobs = await listBatchJobs({ batchId: id });
			return NextResponse.json({
				batch: {
					...batch,
					progress: summarizeJobs({ statuses: jobs.map((j) => j.status) }),
				},
				jobs,
			});
		}
		// Status kuota Instagram ikut dikirim supaya halaman bisa memperingatkan
		// tanpa harus menggali log worker.
		return NextResponse.json({
			batches: await listBatches({}),
			kuotaIg: await bacaStatusKuota(),
		});
	} catch (error) {
		console.error("GET /api/klip/batches failed", error);
		return NextResponse.json({ error: "Batch list failed" }, { status: 500 });
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
		const caption =
			typeof body.caption === "string" && body.caption.trim()
				? body.caption.trim().slice(0, MAX_CAPTION_LENGTH)
				: null;
		const igAccountId =
			typeof body.ig_account_id === "string" && body.ig_account_id.trim()
				? body.ig_account_id.trim().slice(0, 64)
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
		return await persist({
			bytes,
			filename,
			templateId,
			caption,
			igAccountId,
			source: "api",
			ownerUserId,
		});
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
	// Tanda tangan diperiksa SETELAH byte-nya terbaca: HMAC menutupi isi berkas,
	// jadi tidak ada cara memverifikasi tanpa membacanya lebih dulu. Unggahan
	// dari UI tidak menandatangani apa pun dan tetap diterima selama
	// KLIP_WEBHOOK_SECRET belum diisi - lihat catatan di webhook-signature.ts.
	const bytes = Buffer.from(await file.arrayBuffer());
	if (signatureRequired()) {
		const header = request.headers.get(SIGNATURE_HEADER);
		if (!signatureMatches({ body: bytes, header })) {
			return NextResponse.json(
				{
					error: header
						? "Invalid signature"
						: "Missing X-OpenShorts-Signature header",
				},
				{ status: 401 },
			);
		}
	}

	const rawTemplate = form.get("templateId");
	const templateId =
		typeof rawTemplate === "string" && rawTemplate.trim() ? rawTemplate.trim() : null;
	// Caption untuk semua video di batch. Kosong = posting tanpa caption.
	const rawCaption = form.get("caption");
	const caption =
		typeof rawCaption === "string" && rawCaption.trim()
			? rawCaption.trim().slice(0, MAX_CAPTION_LENGTH)
			: null;
	// Akun IG tujuan; kosong = pakai default dari klip_settings.
	const rawIgAccount = form.get("igAccountId");
	const igAccountId =
		typeof rawIgAccount === "string" && rawIgAccount.trim()
			? rawIgAccount.trim().slice(0, 64)
			: null;
	const ownerUserId = requireOwner();
	if (!ownerUserId) return noOwnerResponse();
	return await persist({
		bytes,
		filename: file.name,
		templateId,
		caption,
		igAccountId,
		source: "upload",
		ownerUserId,
	});
}

async function persist({
	bytes,
	filename,
	templateId,
	caption,
	igAccountId,
	source,
	ownerUserId,
}: {
	bytes: Buffer;
	filename: string;
	templateId: string | null;
	caption: string | null;
	igAccountId: string | null;
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
				caption,
				igAccountId,
				source,
				ownerUserId,
			},
		});
		// Dikirim tanpa di-await: notifikasi tidak boleh menahan respons 202,
		// dan kegagalannya tidak boleh menggagalkan batch yang sudah tercatat.
		void sendTelegram(
			pesanBatchDiterima({
				jobCount: created.jobCount,
				sumber: source === "api" ? "OpenShorts" : null,
				sudahAda: 0,
			}),
		);
		return NextResponse.json(
			{
				batchId: created.id,
				status: "queued",
				jobCount: created.jobCount,
				templateId: created.templateId,
				caption: created.caption,
				igAccountId: created.igAccountId,
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
