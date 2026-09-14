import { asc, eq } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches } from "@/db";
import { newBatchRowId, newJobId } from "@/klip/batch-store";
import { resolveBatchSettings } from "@/klip/settings";

export type BatchSource = "upload" | "api";

/**
 * Pemilik batch (keputusan #6): diambil dari ENV, bukan dari tabel `users`.
 *
 * Kenapa env: login app ini memakai cookie HMAC dari APP_USER/APP_PASSWORD
 * (klip/auth-session.ts), BUKAN Better Auth. Tabel `users` karena itu KOSONG
 * di produksi maupun lokal, dan proyek tetap bisa dibuat karena
 * resolveOrCreateProject menyusun barisnya sendiri.
 *
 * Sengaja TIDAK membaca tabel `users`: kalau suatu saat tabel itu terisi
 * (mis. Better Auth dinyalakan), owner batch akan diam-diam berpindah dari
 * env ke user pertama. Sistem tidak boleh menebak seperti itu — sumbernya
 * harus satu dan eksplisit.
 *
 * Prioritas:
 *   1. KLIP_OWNER_ID  - khusus batch; pakai ini kalau batch bukan milik orang
 *   2. APP_USER       - identitas login yang sudah dipakai app ini
 *
 * Tahap 5 (API-driven) menggantinya dengan owner per-request.
 */
export function resolveDefaultOwnerUserId(): string | null {
	const explicit = process.env.KLIP_OWNER_ID?.trim();
	if (explicit) return `app:${explicit}`.slice(0, 64);
	const sessionUser = process.env.APP_USER?.trim();
	if (sessionUser) return `app:${sessionUser}`.slice(0, 64);
	return null;
}

export type CreateBatchInput = {
	zipPath: string;
	zipBytes: number;
	entryNames: string[];
	templateId: string | null;
	/** Caption IG untuk semua video di batch; kosong = tanpa caption. */
	caption: string | null;
	source: BatchSource;
	ownerUserId: string | null;
};

export type CreatedBatch = {
	id: string;
	jobCount: number;
	templateId: string | null;
	caption: string | null;
	ownerUserId: string | null;
};

/**
 * Catat batch + satu job per entri zip. TIDAK mengerjakan apa pun —
 * worker (Tahap 2) yang mengambilnya dari tabel klip_batch_jobs.
 *
 * templateId null berarti "pakai default global nanti saat dikerjakan",
 * jadi template default boleh diubah setelah batch dibuat tanpa mengubah
 * batch yang sudah masuk. Itu sebabnya kita tidak menyalin default ke sini.
 */
export async function createBatch({
	input,
}: {
	input: CreateBatchInput;
}): Promise<CreatedBatch> {
	const id = newBatchRowId();
	const total = input.entryNames.length;
	await db.insert(klipBatches).values({
		id,
		ownerUserId: input.ownerUserId,
		templateId: input.templateId,
		caption: input.caption,
		source: input.source,
		zipPath: input.zipPath,
		zipBytes: input.zipBytes,
		status: "queued",
		total,
		succeeded: 0,
		failed: 0,
	});
	await db.insert(klipBatchJobs).values(
		input.entryNames.map((entryName) => ({
			id: newJobId(),
			batchId: id,
			entryName: entryName.slice(0, 512),
			status: "queued" as const,
			attempts: 0,
			maxAttempts: 5,
		})),
	);
	return {
		id,
		jobCount: total,
		templateId: input.templateId,
		caption: input.caption,
		ownerUserId: input.ownerUserId,
	};
}

export async function getBatch({ id }: { id: string }) {
	const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, id)).limit(1);
	return rows[0] ?? null;
}

export async function listBatchJobs({ batchId }: { batchId: string }) {
	return db
		.select()
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, batchId))
		.orderBy(asc(klipBatchJobs.createdAt));
}

/**
 * Template efektif: eksplisit menang, kalau tidak ada pakai default global
 * (keputusan #3). Dipakai worker saat benar-benar menempelkan template.
 */
export async function resolveBatchTemplateId({
	explicitTemplateId,
}: {
	explicitTemplateId: string | null;
}): Promise<string | null> {
	if (explicitTemplateId) return explicitTemplateId;
	const s = await resolveBatchSettings();
	return s.defaultTemplateId;
}
