import { and, eq, inArray } from "drizzle-orm";
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
	type ProcessResult,
} from "@/klip/worker/process";
import { sendTelegram } from "@/klip/alerts";
import {
	type HasilKlip,
	alasanManusiawi,
	nomorDariEntri,
	pesanHasilAkhir,
	pesanMulaiMemproses,
} from "@/klip/worker/notify";

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

/**
 * Status job yang berarti pekerjaannya BELUM tuntas untuk batch ini.
 *
 * "as const" bukan hiasan: kolom status bertipe enum MySQL, dan drizzle
 * menolak array string biasa karena tidak bisa menjamin isinya status yang sah.
 */
const STATUS_BELUM_TUNTAS = [
	"queued",
	"extracting",
	"rendering",
	"publishing",
] as const;

/**
 * Apakah batch ini masih punya pekerjaan tersisa?
 *
 * Dipakai untuk memutuskan kapan ringkasan dikirim. Job yang menunggu jadwal
 * retry berstatus "queued", jadi ia ikut terhitung - dan itu memang benar:
 * batch yang masih menyisakan retry belum final, dan mengirim "selesai"
 * sekarang hanya akan disusul "selesai" lagi nanti.
 */
export async function batchMasihAdaKerja({
	batchId,
}: {
	batchId: string;
}): Promise<boolean> {
	const rows = await db
		.select({ id: klipBatchJobs.id })
		.from(klipBatchJobs)
		.where(
			and(
				eq(klipBatchJobs.batchId, batchId),
				inArray(klipBatchJobs.status, STATUS_BELUM_TUNTAS),
			),
		);
	return rows.length > 0;
}

/** Jumlah seluruh job di batch ini, untuk pesan "mulai memproses". */
async function hitungJobBatch({
	batchId,
}: {
	batchId: string;
}): Promise<number> {
	const rows = await db
		.select({ id: klipBatchJobs.id })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, batchId));
	return rows.length;
}

/**
 * Hasil seluruh batch, dibaca dari DATABASE - bukan dari catatan di memori.
 *
 * KENAPA DARI DB: worker bisa dijalankan berkali-kali untuk batch yang sama
 * (worker:once dua kali untuk batch berisi dua video). Catatan di memori hanya
 * memuat job yang diproses di sesi ITU, sehingga ringkasannya akan berbunyi
 * "1 video" padahal batch-nya berisi dua. Database menyimpan status final
 * setiap job, jadi ringkasannya utuh tidak peduli berapa kali worker dijalankan.
 */
export async function daftarHasilBatch({
	batchId,
}: {
	batchId: string;
}): Promise<HasilKlip[]> {
	const rows = await db
		.select({
			entryName: klipBatchJobs.entryName,
			status: klipBatchJobs.status,
			error: klipBatchJobs.error,
			permalink: klipBatchJobs.permalink,
		})
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, batchId));

	return rows.map((r) => {
		const nomor = nomorDariEntri(r.entryName) ?? 0;
		const judul = r.entryName
			.replace(/^clip_\d+_/i, "")
			.replace(/\.mp4$/i, "");
		if (r.status === "published") {
			return { nomor, judul, status: "published", permalink: r.permalink };
		}
		if (r.status === "rendered") {
			// Ter-render tapi tidak tayang: bukan kegagalan sistem, tapi pembaca
			// tidak boleh mengira sudah posting.
			return { nomor, judul, status: "failed", alasan: "tidak diposting" };
		}
		return {
			nomor,
			judul,
			status: "failed",
			alasan: alasanManusiawi(r.error),
		};
	});
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
	// Batch yang sudah dikirimi tiap pesan, supaya tidak dobel. Disimpan per
	// pemanggilan runWorker; kalau worker dijalankan ulang, DB yang jadi acuan
	// isi ringkasannya sehingga tetap utuh.
	const mulaiTerkirim = new Set<string>();
	const ringkasanTerkirim = new Set<string>();
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
			// "Mulai memproses" dikirim saat job PERTAMA batch ini dikerjakan.
			// Dulu pesan ini ikut dikirim bersama ringkasan, sehingga "mulai"
			// muncul SETELAH pekerjaannya selesai - urutan yang membingungkan
			// dan membuat pesan "mulai" tidak ada gunanya.
			if (!mulaiTerkirim.has(job.batchId)) {
				mulaiTerkirim.add(job.batchId);
				const jumlah = await hitungJobBatch({ batchId: job.batchId });
				await sendTelegram(pesanMulaiMemproses({ jobCount: jumlah }));
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

			// Ringkasan dikirim begitu batch ini TUNTAS - bukan saat worker
			// berhenti. Worker produksi berjalan terus dan tidak pernah berhenti,
			// jadi ringkasan yang menunggu worker berhenti tidak akan pernah
			// terkirim sama sekali.
			await kirimRingkasanJikaTuntas({
				batchId: job.batchId,
				ringkasanTerkirim,
				say,
			});

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

/**
 * Kirim ringkasan batch, tapi hanya kalau batch-nya sudah TUNTAS.
 *
 * KENAPA DI SINI, BUKAN DI AKHIR runWorker: worker produksi berjalan
 * terus-menerus dan tidak pernah keluar dari loop-nya, sehingga ringkasan yang
 * menunggu worker berhenti tidak akan pernah terkirim. Memeriksa tiap job
 * selesai membuat ketiga mode (once / drain / terus-menerus) berperilaku sama.
 *
 * Isinya dibaca dari database, bukan dari catatan sesi ini, supaya batch yang
 * dikerjakan bertahap (worker:once dua kali untuk dua video) tetap menghasilkan
 * satu ringkasan berisi DUA video, bukan dua ringkasan berisi satu.
 *
 * Tidak pernah melempar: notifikasi adalah efek samping, bukan hasil pekerjaan.
 */
async function kirimRingkasanJikaTuntas({
	batchId,
	ringkasanTerkirim,
	say,
}: {
	batchId: string;
	ringkasanTerkirim: Set<string>;
	say: (m: string) => void;
}): Promise<void> {
	if (ringkasanTerkirim.has(batchId)) return;
	try {
		if (await batchMasihAdaKerja({ batchId })) return;
		const hasil = await daftarHasilBatch({ batchId });
		if (hasil.length === 0) return;
		// Ditandai SEBELUM kirim: kalau pengiriman gagal, lebih baik ringkasan
		// hilang daripada terkirim berkali-kali setiap kali loop memeriksa.
		ringkasanTerkirim.add(batchId);
		await sendTelegram(
			pesanHasilAkhir({ judul: "", hasil, akun: process.env.KLIP_IG_USERNAME }),
		);
	} catch (error) {
		say(
			`ringkasan batch ${batchId} gagal: ${error instanceof Error ? error.message : error}`,
		);
	}
}
