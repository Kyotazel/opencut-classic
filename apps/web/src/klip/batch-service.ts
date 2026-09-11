import { asc, eq } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches, users } from "@/db";
import { newBatchRowId, newJobId } from "@/klip/batch-store";
import { resolveBatchSettings } from "@/klip/settings";

export type BatchSource = "upload" | "api";

/**
 * Pemilik batch (keputusan #6).
 *
 * PENTING: login di aplikasi ini memakai cookie HMAC dari APP_USER/APP_PASSWORD
 * (lihat klip/auth-session.ts), BUKAN Better Auth. Akibatnya tabel `users`
 * sering KOSONG walaupun seseorang sedang login — proyek tetap bisa dibuat
 * karena resolveOrCreateProject membuat barisnya sendiri.
 *
 * Jadi urutannya:
 *   1. user pertama di tabel `users` (kalau ada — mis. Better Auth aktif)
 *   2. nama user dari sesi login (APP_USER), ditulis sebagai owner sintetis
 *
 * Ini tetap pinjaman sampai Tahap 5 menggantinya dengan owner per-request.
 */
export async function resolveDefaultOwnerUserId({
	sessionUser,
}: {
	sessionUser?: string | null;
} = {}): Promise<string | null> {
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.orderBy(asc(users.createdAt))
		.limit(1);
	if (rows[0]) return rows[0].id;
	// Owner sintetis: identitas login yang sebenarnya dipakai app ini.
	const name = sessionUser?.trim();
	if (!name) return null;
	return `app:${name}`.slice(0, 64);
}

export type CreateBatchInput = {
	zipPath: string;
	zipBytes: number;
	entryNames: string[];
	templateId: string | null;
	source: BatchSource;
	ownerUserId: string | null;
};

export type CreatedBatch = {
	id: string;
	jobCount: number;
	templateId: string | null;
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
	return { id, jobCount: total, templateId: input.templateId, ownerUserId: input.ownerUserId };
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
