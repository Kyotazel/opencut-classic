import { eq } from "drizzle-orm";
import { db, klipBatchJobs } from "@/db";
import { claimNextJob, processJob, refreshBatchCounters, WORKER_ID } from "@/klip/worker/process";

/** Jeda antar polling saat tidak ada job. */
export const IDLE_POLL_MS = 5_000;
/** Jeda setelah satu job selesai; menahan laju supaya server tidak dibanjiri. */
export const BUSY_POLL_MS = 1_000;
/** Jeda retry untuk kegagalan yang mungkin sembuh sendiri. */
export const RETRY_DELAY_MS = 5 * 60_000;

/**
 * Hitung jadwal retry berikutnya.
 *
 * attempts sudah dipakai sampai batas -> job dianggap gagal permanen dan
 * TIDAK dijadwalkan lagi. Selain itu dijadwalkan mundur, supaya kegagalan
 * sesaat (file terkunci, disk penuh) tidak menghabiskan kuota retry.
 */
export function nextRetryAt({
	attempts,
	maxAttempts,
	now,
}: {
	attempts: number;
	maxAttempts: number;
	now: Date;
}): Date | null {
	if (attempts + 1 >= maxAttempts) return null;
	return new Date(now.getTime() + RETRY_DELAY_MS);
}

export type WorkerOptions = {
	signal?: AbortSignal;
	once?: boolean;
	log?: (message: string, extra?: unknown) => void;
};

async function handleFailure({
	job,
	error,
	log,
}: {
	job: Awaited<ReturnType<typeof claimNextJob>> & object;
	error: unknown;
	log: (message: string, extra?: unknown) => void;
}): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const attempts = job.attempts + 1;
	const retryAt = nextRetryAt({ attempts, maxAttempts: job.maxAttempts, now: new Date() });
	await db
		.update(klipBatchJobs)
		.set({
			status: retryAt ? "queued" : "failed",
			attempts,
			nextAttemptAt: retryAt,
			error: message,
			lockedAt: null,
			lockedBy: null,
			updatedAt: new Date(),
		})
		.where(eq(klipBatchJobs.id, job.id));
	log(
		retryAt
			? `job ${job.id} gagal, dicoba lagi nanti`
			: `job ${job.id} gagal permanen (${attempts}/${job.maxAttempts})`,
		message,
	);
}

/**
 * Loop worker. Mengambil job satu per satu (SERIAL, bukan paralel) supaya
 * server yang juga melayani situs lain tidak kehabisan CPU/RAM - lihat T3-4.
 * Berhenti kalau signal dibatalkan, atau setelah satu job kalau once=true.
 */
export async function runWorker({ signal, once, log }: WorkerOptions = {}): Promise<void> {
	const say = log ?? ((m: string) => console.log(`[${WORKER_ID}] ${m}`));
	say("worker mulai");
	let processed = 0;
	while (!signal?.aborted) {
		const job = await claimNextJob();
		if (!job) {
			if (once && processed > 0) break;
			if (once) break;
			await sleep({ ms: IDLE_POLL_MS, signal });
			continue;
		}
		say(`kerjakan ${job.id} (${job.entryName})`);
		try {
			const result = await processJob({ job });
			if (result.kind === "rendered") {
				say(`selesai ${job.id} -> project ${result.projectId}`);
			} else if (result.kind === "skipped") {
				say(`lewati ${job.id}: ${result.reason}`);
			} else if (result.kind === "failed") {
				await handleFailure({
					job: { ...job, ...result } as never,
					error: new Error(result.error),
					log: say,
				});
			}
		} catch (error) {
			await handleFailure({ job, error, log: say });
		}
		await refreshBatchCounters({ batchId: job.batchId });
		processed += 1;
		if (once) break;
		await sleep({ ms: BUSY_POLL_MS, signal });
	}
	say("worker berhenti");
}

function sleep({ ms, signal }: { ms: number; signal?: AbortSignal }): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
