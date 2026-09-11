import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches } from "@/db";

/**
 * Ringkasan progres batch untuk UI tracking.
 *
 * Dihitung dari baris job, bukan dari kolom counter di klip_batches, supaya
 * angka yang ditampilkan selalu konsisten dengan kenyataan - kolom counter
 * baru dipercaya setelah worker (Tahap 2) yang mengisinya.
 */
export type BatchProgress = {
	queued: number;
	running: number;
	done: number;
	failed: number;
};

const RUNNING_STATUSES = new Set(["extracting", "rendering", "publishing"]);
const DONE_STATUSES = new Set(["rendered", "published"]);

export function summarizeJobs({
	statuses,
}: {
	statuses: string[];
}): BatchProgress {
	const out: BatchProgress = { queued: 0, running: 0, done: 0, failed: 0 };
	for (const s of statuses) {
		if (s === "queued") out.queued += 1;
		else if (DONE_STATUSES.has(s)) out.done += 1;
		else if (s === "failed" || s === "cancelled") out.failed += 1;
		else if (RUNNING_STATUSES.has(s)) out.running += 1;
		else out.queued += 1;
	}
	return out;
}

/** Daftar batch terbaru + progres, untuk halaman /batches. */
export async function listBatches({ limit }: { limit?: number } = {}) {
	const batches = await db
		.select()
		.from(klipBatches)
		.orderBy(desc(klipBatches.createdAt))
		.limit(Math.min(Math.max(limit ?? 50, 1), 200));
	if (batches.length === 0) return [];
	const jobs = await db
		.select({ batchId: klipBatchJobs.batchId, status: klipBatchJobs.status })
		.from(klipBatchJobs)
		.where(inArray(klipBatchJobs.batchId, batches.map((b) => b.id)));
	const byBatch = new Map<string, string[]>();
	for (const j of jobs) {
		const list = byBatch.get(j.batchId) ?? [];
		list.push(j.status);
		byBatch.set(j.batchId, list);
	}
	return batches.map((b) => ({
		...b,
		progress: summarizeJobs({ statuses: byBatch.get(b.id) ?? [] }),
	}));
}

export type BatchWithProgress = Awaited<ReturnType<typeof listBatches>>[number];

/** Batch tunggal + job-nya, untuk halaman detail. */
export async function getBatchDetail({ id }: { id: string }) {
	const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, id)).limit(1);
	const batch = rows[0];
	if (!batch) return null;
	const jobs = await db
		.select()
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, id))
		.orderBy(asc(klipBatchJobs.createdAt));
	return { batch, jobs, progress: summarizeJobs({ statuses: jobs.map((j) => j.status) }) };
}
