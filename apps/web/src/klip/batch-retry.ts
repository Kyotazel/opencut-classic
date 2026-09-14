import { and, eq, inArray } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches } from "@/db";
import { refreshBatchCounters } from "@/klip/worker/process";

/**
 * Menjalankan ulang job yang gagal, dari percobaan pertama lagi.
 *
 * KENAPA ADA: job punya `max_attempts` (5). Setelah habis, worker menandainya
 * gagal permanen dan tidak pernah menyentuhnya lagi - bahkan setelah penyebab
 * kegagalannya diperbaiki. Tanpa jalur ini, satu-satunya cara mencoba ulang
 * adalah menyunting database secara manual.
 *
 * Dua hal yang di-reset, dan satu yang TIDAK:
 *   - `attempts` kembali 0, jadi jatahnya penuh 5 percobaan lagi
 *   - `status` kembali "queued" supaya worker mengambilnya lagi
 *   - `rendered_path` DIPERTAHANKAN kalau sudah ada: render memakan ~17x durasi
 *     video di server ini, jadi job yang gagal di tahap publish tidak boleh
 *     merender ulang. Pakai `fresh` untuk memaksa render ulang.
 */

/**
 * Status yang boleh dijalankan ulang.
 *
 * "published" sengaja TIDAK ada di sini: menjalankan ulang job yang sudah
 * terbit akan membuat postingan DUPLIKAT di akun publik, dan Instagram tidak
 * punya cara membatalkannya dari sisi kita. Kalau memang ingin menerbitkan
 * ulang, itu tindakan sadar yang terpisah - bukan efek samping tombol.
 *
 * "queued" juga tidak ada: job itu sudah akan dikerjakan, tidak ada yang perlu
 * direset.
 */
const RETRYABLE = new Set(["failed", "cancelled", "rendered"]);

export type RetryResult = {
	/** Job yang benar-benar di-reset. */
	retried: string[];
	/** Job yang dilewati, beserta alasannya. */
	skipped: { id: string; reason: string }[];
};

/**
 * Jalankan ulang satu job.
 *
 * `fresh` = buang hasil render supaya dirender ulang dari nol. Dipakai kalau
 * berkasnya sendiri yang dicurigai rusak, bukan sekadar publish-nya gagal.
 */
export async function retryJob({
	jobId,
	fresh = false,
}: {
	jobId: string;
	fresh?: boolean;
}): Promise<RetryResult> {
	const rows = await db
		.select()
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.id, jobId))
		.limit(1);
	const job = rows[0];
	if (!job) return { retried: [], skipped: [{ id: jobId, reason: "job tidak ada" }] };
	if (!RETRYABLE.has(job.status)) {
		return {
			retried: [],
			skipped: [{ id: jobId, reason: `status ${job.status} tidak bisa diulang` }],
		};
	}

	await db
		.update(klipBatchJobs)
		.set({
			status: "queued",
			// Jatah percobaan kembali penuh - ini inti permintaannya.
			attempts: 0,
			nextAttemptAt: null,
			error: null,
			stage: null,
			lockedAt: null,
			lockedBy: null,
			...(fresh ? { renderedPath: null } : {}),
			updatedAt: new Date(),
		})
		.where(eq(klipBatchJobs.id, jobId));

	await reopenBatch({ batchId: job.batchId });
	return { retried: [jobId], skipped: [] };
}

/** Jalankan ulang SEMUA job gagal di satu batch. */
export async function retryFailedJobsInBatch({
	batchId,
	fresh = false,
}: {
	batchId: string;
	fresh?: boolean;
}): Promise<RetryResult> {
	const rows = await db
		.select({ id: klipBatchJobs.id, status: klipBatchJobs.status })
		.from(klipBatchJobs)
		.where(and(eq(klipBatchJobs.batchId, batchId), inArray(klipBatchJobs.status, ["failed", "cancelled"])));

	if (rows.length === 0) {
		return { retried: [], skipped: [{ id: batchId, reason: "tidak ada job gagal" }] };
	}

	await db
		.update(klipBatchJobs)
		.set({
			status: "queued",
			attempts: 0,
			nextAttemptAt: null,
			error: null,
			stage: null,
			lockedAt: null,
			lockedBy: null,
			...(fresh ? { renderedPath: null } : {}),
			updatedAt: new Date(),
		})
		.where(inArray(klipBatchJobs.id, rows.map((r) => r.id)));

	await reopenBatch({ batchId });
	return { retried: rows.map((r) => r.id), skipped: [] };
}

/**
 * Buka lagi batch yang mungkin sedang "halted".
 *
 * PENTING: claimNextJob sengaja MENOLAK mengambil job dari batch berstatus
 * halted - itu yang membuat circuit breaker benar-benar menghentikan kerja.
 * Konsekuensinya, menjalankan ulang job TIDAK cukup: batch-nya harus dibuka
 * dulu, kalau tidak job akan mengantri selamanya tanpa pernah dikerjakan.
 */
async function reopenBatch({ batchId }: { batchId: string }): Promise<void> {
	await db
		.update(klipBatches)
		.set({ status: "running", haltedReason: null, updatedAt: new Date() })
		.where(eq(klipBatches.id, batchId));
	await refreshBatchCounters({ batchId });
}
