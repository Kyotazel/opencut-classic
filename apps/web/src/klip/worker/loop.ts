import { and, eq } from "drizzle-orm";
import { db, klipBatchJobs } from "@/db";
import { ChromiumRunner } from "@/klip/worker/chromium";
import {
	claimNextJob,
	processJob,
	refreshBatchCounters,
	WORKER_ID,
	type ClaimedJob,
} from "@/klip/worker/process";

/** Jeda antar polling saat tidak ada job. */
export const IDLE_POLL_MS = 5_000;
/** Jeda setelah satu job selesai; menahan laju supaya server tidak dibanjiri. */
export const BUSY_POLL_MS = 1_000;
/** Jeda retry untuk kegagalan yang mungkin sembuh sendiri. */
export const RETRY_DELAY_MS = 5 * 60_000;

/**
 * Hitung jadwal retry berikutnya.
 *
 * attempts sudah dipakai sampai batas -> job gagal permanen dan TIDAK
 * dijadwalkan lagi. Selain itu dijadwalkan mundur, supaya kegagalan sesaat
 * (file terkunci, disk penuh) tidak menghabiskan kuota retry.
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
	/** Kerjakan SATU job lalu berhenti. Dipakai untuk mencoba satu langkah. */
	once?: boolean;
	/**
	 * Kerjakan semua job yang SIAP, lalu berhenti.
	 *
	 * Job yang dijadwalkan ulang (next_attempt_at di masa depan, mis. karena
	 * kena rate limit) TIDAK ditunggu - kalau ditunggu, perintah ini bisa
	 * menggantung berjam-jam. Jalankan lagi nanti untuk memprosesnya.
	 */
	drain?: boolean;
	log?: (message: string, extra?: unknown) => void;
	/** Batasi ke satu batch; kosong = job mana pun. Dipakai tes. */
	batchId?: string;
	/** Basis URL halaman internal, mis. http://127.0.0.1:3000 */
	baseUrl: string;
	/** Kredensial login untuk Chromium. */
	username: string;
	password: string;
};

async function handleFailure({
	job,
	error,
	log,
}: {
	job: ClaimedJob;
	error: unknown;
	log: (message: string, extra?: unknown) => void;
}): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const attempts = job.attempts + 1;
	const retryAt = nextRetryAt({
		attempts,
		maxAttempts: job.maxAttempts,
		now: new Date(),
	});
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
 * Job yang masih menunggu jadwal retry (next_attempt_at di masa depan).
 * Dipakai hanya untuk memberi tahu user; bukan penghalang.
 */
async function countScheduledJobs({ batchId }: { batchId?: string }): Promise<number> {
	const rows = await db
		.select({ id: klipBatchJobs.id })
		.from(klipBatchJobs)
		.where(
			and(
				eq(klipBatchJobs.status, "queued"),
				batchId ? eq(klipBatchJobs.batchId, batchId) : undefined,
			),
		);
	return rows.length;
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

/**
 * Loop worker. Mengambil job satu per satu (SERIAL, bukan paralel) supaya
 * server yang juga melayani situs lain tidak kehabisan CPU/RAM - lihat T3-4.
 */
export async function runWorker({
	signal,
	once,
	drain,
	log,
	batchId,
	baseUrl,
	username,
	password,
}: WorkerOptions): Promise<void> {
	const say = log ?? ((m: string) => console.log(`[${WORKER_ID}] ${m}`));
	say("worker mulai");
	// Satu Chromium dipakai ulang antar job; membuka browser per job boros.
	const runner = new ChromiumRunner({ baseUrl, username, password });
	let processed = 0;
	try {
		while (!signal?.aborted) {
			const job = await claimNextJob({ batchId });
			if (!job) {
				// once = satu job; drain = habiskan yang siap; selain itu tunggu
				// job baru terus-menerus.
				if (once || drain) break;
				await sleep({ ms: IDLE_POLL_MS, signal });
				continue;
			}
			say(`kerjakan ${job.id} (${job.entryName})`);
			try {
				const result = await processJob({ job, runner, baseUrl });
				if (result.kind === "rendered") {
					say(`selesai ${job.id} -> project ${result.projectId}`);
				} else if (result.kind === "skipped") {
					say(`lewati ${job.id}: ${result.reason}`);
				} else {
					await handleFailure({
						job,
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
	} finally {
		await runner.close();
	}
	if (drain) {
		const pending = await countScheduledJobs({ batchId });
		if (pending > 0) {
			say(`${pending} job masih terjadwal (retry), jalankan lagi nanti`);
		}
	}
	say(`worker berhenti (${processed} job)`);
}
