import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { MAX_ZIP_BYTES } from "@/klip/batch-upload";
import { listZipEntries, saveBatchZip } from "@/klip/batch-store";
import { createBatch, resolveDefaultOwnerUserId } from "@/klip/batch-service";
import { dataRoot, UploadError } from "@/klip/upload";
import { SESSION_COOKIE } from "@/klip/auth-session";

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
 * Pemilik batch (keputusan #6). Memakai user pertama di tabel `users`, atau
 * jatuh ke identitas sesi login — karena login app ini memakai cookie
 * APP_USER, bukan Better Auth, sehingga tabel `users` bisa kosong.
 */
async function requireOwner({ request }: { request: NextRequest }): Promise<string | null> {
	return resolveDefaultOwnerUserId({ sessionUser: sessionUserId({ request }) });
}

/**
 * Baca nama user dari cookie sesi. Middleware sudah memverifikasi tanda
 * tangannya sebelum route ini berjalan, jadi di sini cukup membaca payload.
 */
function sessionUserId({ request }: { request: NextRequest }): string | null {
	// Dibaca dari header Cookie, bukan request.cookies, supaya jalur ini juga
	// bisa diuji dengan Request biasa (tanpa NextRequest penuh).
	const raw = request.headers.get("cookie") ?? "";
	const cookie = raw
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${SESSION_COOKIE}=`))
		?.slice(SESSION_COOKIE.length + 1);
	if (!cookie) return null;
	const decoded = decodeURIComponent(cookie);
	const dot = decoded.lastIndexOf(".");
	if (dot < 0) return null;
	const payload = decoded.slice(0, dot);
	const sep = payload.indexOf(":");
	if (sep < 0) return null;
	const user = payload.slice(0, sep);
	return user || null;
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
		const ownerUserId = await requireOwner({ request });
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
	const ownerUserId = await requireOwner({ request });
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
