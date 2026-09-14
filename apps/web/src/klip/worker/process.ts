import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches, klipProjects } from "@/db";
import { resolveBatchTemplateId } from "@/klip/batch-service";
import { resolveOrCreateProject } from "@/klip/brand";
import { applyTemplate } from "@/klip/templates";
import { dataRoot } from "@/klip/upload";
import { ChromiumRunner } from "@/klip/worker/chromium";
import { extractVideosFromZip } from "@/klip/worker/extract";

export const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

export type ClaimedJob = {
	id: string;
	batchId: string;
	entryName: string;
	attempts: number;
	maxAttempts: number;
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
			status: allSettled ? (failed > 0 ? "partial" : "done") : "running",
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

export type ProcessResult =
	| { kind: "rendered"; projectId: string; video: string }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; error: string };

/**
 * Kerjakan satu job: ekstrak ZIP, lalu suruh Chromium membuat project dan
 * menempelkan template memakai kode editor yang sama dengan UI.
 */
export async function processJob({
	job,
	runner,
	baseUrl,
}: {
	job: ClaimedJob;
	runner: ChromiumRunner;
	baseUrl: string;
}): Promise<ProcessResult> {
	const batches = await db
		.select()
		.from(klipBatches)
		.where(eq(klipBatches.id, job.batchId))
		.limit(1);
	const batch = batches[0];
	if (!batch) return { kind: "failed", error: "batch not found" };

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

	// Id project ditentukan di sini supaya worker bisa menautkannya ke job.
	const opencutRef = randomUUID();
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

	await setJob({
		id: job.id,
		values: {
			status: "rendered",
			stage: "done",
			attempts: job.attempts + 1,
			lockedAt: null,
			lockedBy: null,
			error: null,
		},
	});
	return { kind: "rendered", projectId: project.id, video: video.entryName };
}
