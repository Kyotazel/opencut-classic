import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, desc, eq, isNull, lte, notInArray, or } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches, klipProjects } from "@/db";
import { resolveBatchTemplateId } from "@/klip/batch-service";
import { resolveOrCreateProject } from "@/klip/brand";
import { applyTemplate } from "@/klip/templates";
import { dataRoot } from "@/klip/upload";
import { ChromiumRunner } from "@/klip/worker/chromium";
import { extractVideosFromZip } from "@/klip/worker/extract";
import { isRateLimitError, publishRenderedVideo } from "@/klip/worker/publish";
import { resolveBatchSettings } from "@/klip/settings";

export const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

/**
 * Tahap yang dianggap "kegagalan yang butuh perhatian manusia".
 *
 * publish_rate_limited sengaja TIDAK ada di sini: kena batas laju Instagram
 * bukan tanda ada yang salah, hanya perlu ditunggu.
 */
const FAILURE_STAGES = new Set(["publish_failed", "render_failed"]);

export type ClaimedJob = {
	id: string;
	batchId: string;
	entryName: string;
	attempts: number;
	maxAttempts: number;
	/** Terisi kalau job ini pernah sampai tahap pembuatan project. */
	projectId: string | null;
};

/**
 * Klaim satu job secara atomik.
 *
 * Redis belum jalan, jadi dipakai transaksi MySQL dengan SELECT ... FOR UPDATE:
 * dua worker yang bersamaan tidak boleh mengambil baris yang sama (T2-3).
 * Job dengan next_attempt_at di masa depan dilewati sampai waktunya.
 *
 * `batchId` hanya dipakai tes untuk mengunci pencarian ke batch miliknya.
 */
export async function claimNextJob({
	batchId,
}: {
	batchId?: string;
} = {}): Promise<ClaimedJob | null> {
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(klipBatchJobs)
			.where(
				and(
					eq(klipBatchJobs.status, "queued"),
					isNull(klipBatchJobs.lockedAt),
					// Batch yang dihentikan circuit breaker tidak boleh dilanjutkan:
					// tanpa ini, sisa job tetap diambil dan video salah terus terkirim.
					notInArray(
						klipBatchJobs.batchId,
						db
							.select({ id: klipBatches.id })
							.from(klipBatches)
							.where(eq(klipBatches.status, "halted")),
					),
					batchId ? eq(klipBatchJobs.batchId, batchId) : undefined,
					or(
						isNull(klipBatchJobs.nextAttemptAt),
						lte(klipBatchJobs.nextAttemptAt, new Date()),
					),
				),
			)
			.orderBy(asc(klipBatchJobs.createdAt))
			.limit(1)
			.for("update");
		const job = rows[0];
		if (!job) return null;
		await tx
			.update(klipBatchJobs)
			.set({ lockedAt: new Date(), lockedBy: WORKER_ID, updatedAt: new Date() })
			.where(eq(klipBatchJobs.id, job.id));
		return {
			id: job.id,
			batchId: job.batchId,
			entryName: job.entryName,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			projectId: job.projectId,
		};
	});
}

async function setJob({
	id,
	values,
}: {
	id: string;
	values: Partial<typeof klipBatchJobs.$inferInsert>;
}): Promise<void> {
	await db
		.update(klipBatchJobs)
		.set({ ...values, updatedAt: new Date() })
		.where(eq(klipBatchJobs.id, id));
}

/**
 * Hitung ulang counter batch dari baris job. Selalu dihitung, tidak
 * di-increment, supaya angka tetap benar walau worker mati di tengah jalan.
 */
export async function refreshBatchCounters({
	batchId,
}: {
	batchId: string;
}): Promise<void> {
	const rows = await db
		.select({ status: klipBatchJobs.status })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, batchId));
	const total = rows.length;
	// Batch yang dihentikan circuit breaker statusnya final: hitungan tetap
	// diperbarui, tapi statusnya tidak boleh dikembalikan jadi "running".
	const current = await db
		.select({ status: klipBatches.status })
		.from(klipBatches)
		.where(eq(klipBatches.id, batchId))
		.limit(1);
	const halted = current[0]?.status === "halted";
	const done = rows.filter(
		(r) => r.status === "rendered" || r.status === "published",
	).length;
	const failed = rows.filter(
		(r) => r.status === "failed" || r.status === "cancelled",
	).length;
	const allSettled = rows.every((r) =>
		["rendered", "published", "failed", "cancelled"].includes(r.status),
	);
	await db
		.update(klipBatches)
		.set({
			succeeded: done,
			failed,
			total,
			status: halted
				? "halted"
				: allSettled
					? failed > 0
						? "partial"
						: "done"
					: "running",
			updatedAt: new Date(),
		})
		.where(eq(klipBatches.id, batchId));
}

/**
 * URL video hasil ekstraksi untuk dikonsumsi Chromium.
 *
 * Chromium tidak bisa membaca disk langsung; halaman internal mengambil berkas
 * lewat endpoint ini. Path di endpoint itu disusun dari batchId + entri yang
 * terdaftar di database, jadi tidak ada celah traversal.
 */
export function videoUrlFor({
	baseUrl,
	batchId,
	entryName,
}: {
	baseUrl: string;
	batchId: string;
	entryName: string;
}): string {
	const base = baseUrl.replace(/\/$/, "");
	const query = new URLSearchParams({ entry: entryName });
	return `${base}/api/klip/batches/${encodeURIComponent(batchId)}/video?${query.toString()}`;
}

/** opencutRef milik project, atau null kalau project tidak ada / belum dibuat. */
async function opencutRefForProject({
	projectId,
}: {
	projectId: string | null;
}): Promise<string | null> {
	if (!projectId) return null;
	const rows = await db
		.select({ opencutRef: klipProjects.opencutRef })
		.from(klipProjects)
		.where(eq(klipProjects.id, projectId))
		.limit(1);
	return rows[0]?.opencutRef ?? null;
}

type RenderState = { renderedPath: string | null; stage: string | null };

export type ProcessResult =
	| { kind: "rendered"; projectId: string; video: string; note?: string }
	| { kind: "published"; projectId: string; video: string; permalink: string | null }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; error: string };

type ProcessJobArgs = {
	job: ClaimedJob;
	runner: ChromiumRunner;
	baseUrl: string;
};

/**
 * Kerjakan satu job, dan pastikan SETIAP kegagalan meninggalkan jejak tahap.
 *
 * KENAPA DIBUNGKUS: circuit breaker hanya bisa menghitung kegagalan kalau
 * tahapnya tertulis di kolom `stage`. Kegagalan publish menulis tahapnya
 * sendiri dari dalam publishStage; kegagalan RENDER tidak menulis apa pun,
 * sehingga batch yang render-nya rusak secara sistemik akan mengerjakan semua
 * video sampai percobaannya habis tanpa pernah berhenti - ratusan video kali
 * lima percobaan, berjam-jam, untuk hasil nol.
 */
export async function processJob(args: ProcessJobArgs): Promise<ProcessResult> {
	try {
		return await runJob(args);
	} catch (error) {
		const state = await renderStateForJob({ jobId: args.job.id });
		// Tahap publish punya penandanya sendiri (publish_failed /
		// publish_rate_limited) dan breaker-nya sudah dipanggil di sana.
		if (!state.stage?.startsWith("publish")) {
			await setJob({ id: args.job.id, values: { stage: "render_failed" } });
			await maybeHaltBatch({ batchId: args.job.batchId, rateLimited: false });
		}
		throw error;
	}
}

/**
 * Kerjakan satu job: ekstrak ZIP, lalu suruh Chromium membuat project dan
 * menempelkan template memakai kode editor yang sama dengan UI.
 */
async function runJob({ job, runner, baseUrl }: ProcessJobArgs): Promise<ProcessResult> {
	const batches = await db
		.select()
		.from(klipBatches)
		.where(eq(klipBatches.id, job.batchId))
		.limit(1);
	const batch = batches[0];
	if (!batch) return { kind: "failed", error: "batch not found" };

	// Kalau job ini sudah punya hasil render (mis. percobaan sebelumnya gagal di
	// tahap publish), JANGAN render ulang - render memakan ~3,3x durasi video dan
	// mengulanginya hanya membuang waktu serta CPU.
	const existing = await renderStateForJob({ jobId: job.id });
	if (existing.renderedPath && job.projectId) {
		await setJob({ id: job.id, values: { status: "rendering", stage: "render_done" } });
		return await publishStage({
			job,
			batch,
			projectId: job.projectId,
			renderedPath: existing.renderedPath,
		});
	}

	await setJob({ id: job.id, values: { status: "extracting" } });
	const { videos, skipped } = await extractVideosFromZip({
		zipAbsPath: path.join(dataRoot(), batch.zipPath),
		batchId: job.batchId,
	});
	const video = videos.find((v) => v.entryName === job.entryName);
	if (!video) {
		const why = skipped.find((s) => s.entryName === job.entryName)?.reason;
		// Entri non-video bukan kegagalan sistem: tandai selesai tanpa project.
		await setJob({
			id: job.id,
			values: {
				status: "cancelled",
				error: why ?? "entry not found in zip",
				lockedAt: null,
				lockedBy: null,
			},
		});
		return { kind: "skipped", reason: why ?? "entry not found in zip" };
	}

	await setJob({ id: job.id, values: { status: "rendering", stage: "extracted" } });

	// IDEMPOTEN (T2-2): kalau job ini pernah sampai membuat project, pakai ulang
	// opencutRef-nya. Tanpa ini, setiap percobaan ulang membuat project BARU dan
	// database terisi duplikat untuk video yang sama.
	const existingRef = await opencutRefForProject({ projectId: job.projectId });
	const opencutRef = existingRef ?? randomUUID();
	// Template ditentukan SEBELUM halaman internal dijalankan: halaman itu yang
	// menulis layer ke database SEKALIGUS menempelkannya ke timeline. Kalau
	// template ditempel belakangan dari sini, layer hanya tercatat di database
	// dan timeline project tidak ikut terisi.
	const templateId = await resolveBatchTemplateId({
		explicitTemplateId: batch.templateId,
	});
	const projectId = await runner.renderProject({
		input: {
			opencutRef,
			videoUrl: videoUrlFor({ baseUrl, batchId: job.batchId, entryName: job.entryName }),
			entryName: job.entryName,
			templateId,
			// batch + job diteruskan supaya halaman internal ikut merender MP4
			// dan mengunggahnya. Tanpa keduanya, halaman hanya membuat project.
			batchId: job.batchId,
			jobId: job.id,
		},
	});

	// Halaman internal sudah menyimpan project + medianya ke klip_sync_projects.
	// Baris klip_projects BELUM ada, dan klip_batch_jobs.project_id mengacu ke
	// sana - jadi harus dibuat lebih dulu, kalau tidak update di bawah gagal
	// dengan foreign key.
	const project = await resolveOrCreateProject({
		opencutRef,
		name: video.entryName,
	});
	await db
		.update(klipProjects)
		.set({
			batchId: job.batchId,
			duration: video.duration,
			width: video.width,
			height: video.height,
		})
		.where(eq(klipProjects.id, project.id));
	await setJob({ id: job.id, values: { projectId: project.id, stage: "project_created" } });

	const fresh = await renderStateForJob({ jobId: job.id });
	if (!fresh.renderedPath) {
		throw new Error("render selesai tapi berkas tidak tercatat");
	}
	return await publishStage({
		job,
		batch,
		projectId: project.id,
		renderedPath: fresh.renderedPath,
	});
}

/** Berkas hasil render milik job, kalau sudah ada. */
async function renderStateForJob({ jobId }: { jobId: string }): Promise<RenderState> {
	const rows = await db
		.select({ renderedPath: klipBatchJobs.renderedPath, stage: klipBatchJobs.stage })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.id, jobId))
		.limit(1);
	return {
		renderedPath: rows[0]?.renderedPath ?? null,
		stage: rows[0]?.stage ?? null,
	};
}

/**
 * Tahap publish: kirim video ke Instagram, lalu tandai job selesai.
 *
 * Dipisah dari render supaya job yang gagal di tahap ini bisa dicoba ulang
 * TANPA merender ulang.
 */
async function publishStage({
	job,
	batch,
	projectId,
	renderedPath,
}: {
	job: ClaimedJob;
	batch: typeof klipBatches.$inferSelect;
	projectId: string;
	renderedPath: string;
}): Promise<ProcessResult> {
	const settings = await resolveBatchSettings();
	const igAccountId = batch.igAccountId ?? settings.defaultIgAccountId;
	if (!igAccountId) {
		// Tanpa akun tujuan, publish dilewati - bukan kegagalan. Berisik di log
		// supaya tidak terlihat seperti sukses padahal tidak dikirim ke mana pun.
		await setJob({
			id: job.id,
			values: {
				status: "rendered",
				stage: "no_ig_account",
				attempts: job.attempts + 1,
				lockedAt: null,
				lockedBy: null,
				error: null,
			},
		});
		return {
			kind: "rendered",
			projectId,
			video: job.entryName,
			note: "tidak ada akun IG tujuan; publish dilewati",
		};
	}

	await setJob({ id: job.id, values: { status: "publishing", stage: "publishing" } });
	const outcome = await publishRenderedVideo({
		projectId,
		renderedPath,
		caption: batch.caption ?? null,
		igAccountId,
	});

	if (outcome.kind === "published") {
		await db
			.update(klipBatchJobs)
			.set({
				status: "published",
				stage: "published",
				permalink: outcome.permalink,
				attempts: job.attempts + 1,
				lockedAt: null,
				lockedBy: null,
				error: null,
				updatedAt: new Date(),
			})
			.where(eq(klipBatchJobs.id, job.id));
		return {
			kind: "published",
			projectId,
			video: job.entryName,
			permalink: outcome.permalink,
		};
	}

	if (outcome.kind === "skipped") {
		await setJob({
			id: job.id,
			values: {
				status: "rendered",
				stage: "publish_skipped",
				attempts: job.attempts + 1,
				lockedAt: null,
				lockedBy: null,
				error: outcome.reason,
			},
		});
		return { kind: "rendered", projectId, video: job.entryName, note: outcome.reason };
	}

	// Gagal. Tahapnya ditulis LEBIH DULU karena circuit breaker membaca kolom
	// stage - kalau ditulis setelahnya, kegagalan ini tidak akan terhitung.
	const rateLimited = isRateLimitError({ message: outcome.error });
	await setJob({
		id: job.id,
		values: {
			stage: rateLimited ? "publish_rate_limited" : "publish_failed",
			error: outcome.error,
		},
	});
	await maybeHaltBatch({ batchId: job.batchId, rateLimited });
	throw new Error(outcome.error);
}

/**
 * Circuit breaker (N1): kalau beberapa job BERTURUT-TURUT gagal di tahap
 * publish, hentikan seluruh batch.
 *
 * Alasannya: satu kegagalan bisa kebetulan, dua berturut-turut biasanya berarti
 * ada yang salah dengan template atau video - dan tanpa ini, puluhan video
 * salah akan terkirim ke akun publik sebelum ada yang sadar.
 *
 * Kegagalan karena batas laju TIDAK dihitung: itu bukan tanda konten salah.
 *
 * Diekspor untuk tes: perilakunya hanya bisa diuji dengan menyusun riwayat job
 * secara langsung, dan itu jauh lebih murah daripada menjalankan Chromium.
 */
export async function maybeHaltBatch({
	batchId,
	rateLimited,
}: {
	batchId: string;
	rateLimited: boolean;
}): Promise<void> {
	if (rateLimited) return;
	const settings = await resolveBatchSettings();
	const threshold = settings.publishFailureThreshold;
	// Diambil lebih banyak dari ambang, lalu disaring ke stage "publish_failed".
	// Baris rate-limited punya stage sendiri, jadi tersaring otomatis dan tidak
	// pernah ikut menghitung - sesuai alasan di atas.
	const recent = await db
		.select({ stage: klipBatchJobs.stage })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, batchId))
		.orderBy(desc(klipBatchJobs.updatedAt))
		.limit(threshold + 4);
	const failures = recent.filter(
		(r) => r.stage !== null && FAILURE_STAGES.has(r.stage),
	);
	if (failures.length < threshold) return;

	await db
		.update(klipBatches)
		.set({
			status: "halted",
			haltedReason:
				"Dihentikan otomatis: " +
				settings.publishFailureThreshold +
				" video berturut-turut gagal dipublish. Periksa template dan akun Instagram, lalu jalankan lagi.",
			updatedAt: new Date(),
		})
		.where(eq(klipBatches.id, batchId));
}
