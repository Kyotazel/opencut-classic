import { and, eq } from "drizzle-orm";
import { db, klipBatchJobs } from "@/db";
import { ChromiumRunner } from "@/klip/worker/chromium";
import { resolveBatchSettings } from "@/klip/settings";
import { isWithinWindow, minutesUntilWindow } from "@/klip/worker/window";
import { isRateLimitError } from "@/klip/worker/publish";
import {
	estimasiPulihKuotaMenit,
	pemakaianKuotaTerakhir,
} from "@/klip/ig-api";
import { simpanStatusKuota } from "@/klip/ig-quota-status";
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
/** Jeda polling saat di luar window. Satu menit cukup: yang ditunggu
 * hanya pergantian jam, bukan pekerjaan. */
export const WINDOW_POLL_MS = 60_000;

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

/**
 * Jeda setelah kena batas laju Meta.
 *
 * Batas laju aplikasi dihitung PER JAM, jadi menjadwalkan ulang dalam hitungan
 * menit hanya membentur batas yang sama sambil menghabiskan kuota yang tersisa.
 */
export const RATE_LIMIT_RETRY_DELAY_MS = 60 * 60_000;

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
	/**
	 * Abaikan window waktu dan kerjakan sekarang.
	 *
	 * Dipakai tuas "jalankan sekarang": user memaksa satu batch jalan di luar
	 * jam yang diizinkan. Dihormati hanya kalau setelan allow_manual_run aktif.
	 */
	forceNow?: boolean;
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
	// Kena batas laju BUKAN kegagalan job: yang perlu dilakukan hanya menunggu.
	// Jatah percobaan karena itu TIDAK dikurangi - kalau dikurangi, lima kali
	// kena batas laju menghabiskan job yang sebenarnya tidak bermasalah.
	const kenaBatasLaju = isRateLimitError({ message });
	// Jeda memakai perkiraan Meta sendiri kalau tersedia.
	//
	// `estimated_time_to_regain_access` (menit) adalah angka resmi dari Meta,
	// jadi jauh lebih baik daripada menebak satu jam - jendela kuotanya bergulir
	// 24 jam dan pemulihannya bertahap, sehingga tebakan bisa terlalu cepat
	// (menabrak lagi) atau terlalu lambat (menunggu sia-sia).
	const estimasiMenit = estimasiPulihKuotaMenit();
	const jedaMs =
		estimasiMenit !== null && estimasiMenit > 0
			? estimasiMenit * 60_000
			: RATE_LIMIT_RETRY_DELAY_MS;
	const retryAt = kenaBatasLaju
		? new Date(Date.now() + jedaMs)
		: nextRetryAt({
				attempts,
				maxAttempts: job.maxAttempts,
				now: new Date(),
			});
	if (kenaBatasLaju && retryAt) {
		// Dicatat supaya UI bisa menampilkan sisa waktu tanpa menggali log.
		await simpanStatusKuota({
			status: {
				pemakaian: pemakaianKuotaTerakhir(),
				pulihPada: retryAt.toISOString(),
				pesan: message.slice(0, 300),
			},
		}).catch(() => {
			// Pencatatan status tidak boleh menggagalkan penanganan kegagalan.
		});
	}
	await db
		.update(klipBatchJobs)
		.set({
			status: retryAt ? "queued" : "failed",
			attempts: kenaBatasLaju ? job.attempts : attempts,
			nextAttemptAt: retryAt,
			error: message,
			lockedAt: null,
			lockedBy: null,
			updatedAt: new Date(),
		})
		.where(eq(klipBatchJobs.id, job.id));
	log(
		kenaBatasLaju
			? `job ${job.id} kena batas laju Instagram; dicoba lagi ${Math.round(jedaMs / 60_000)} menit lagi (perkiraan Meta), jatah percobaan tidak dikurangi`
			: retryAt
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
	forceNow,
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
			// Window waktu (T3-5): tuas tunggal yang membatasi CPU server, RAM
			// Chromium, dan laju publish IG sekaligus. Di luar window worker
			// MENUNGGU - job tidak hilang, hanya ditunda.
			const settings = await resolveBatchSettings();
			if (settings.windowEnabled && !forceNow) {
				const now = new Date();
				const within = isWithinWindow({
					now: { hour: now.getHours(), minute: now.getMinutes() },
					start: settings.windowStart,
					end: settings.windowEnd,
				});
				if (!within) {
					const wait = minutesUntilWindow({
						now: { hour: now.getHours(), minute: now.getMinutes() },
						start: settings.windowStart,
						end: settings.windowEnd,
					});
					say(
						`di luar window render, menunggu ${wait} menit lagi (jam ${settings.windowStart?.hour ?? 0}:${String(settings.windowStart?.minute ?? 0).padStart(2, "0")}-${settings.windowEnd?.hour ?? 0}:${String(settings.windowEnd?.minute ?? 0).padStart(2, "0")})`,
					);
					if (once || drain) break;
					await sleep({ ms: WINDOW_POLL_MS, signal });
					continue;
				}
			}
			if (settings.windowEnabled && forceNow) {
				say("window dimatikan untuk proses ini (jalankan sekarang)");
			}

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
				} else if (result.kind === "published") {
					say(
						`publish ${job.id} -> ${result.permalink ?? "(permalink tidak dikembalikan IG)"}`,
					);
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
