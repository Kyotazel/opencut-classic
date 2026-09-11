import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import {
	db,
	klipBatchJobs,
	klipBatches,
	klipProjects,
	klipSyncMedia,
	klipSyncProjects,
} from "@/db";
import { resolveOrCreateProject } from "@/klip/brand";
import { extractVideosFromZip } from "@/klip/worker/extract";
import { buildProjectFromVideo, serializeProjectForServer } from "@/klip/worker/project-builder";
import { applyTemplate } from "@/klip/templates";
import { dataRoot } from "@/klip/upload";
import { resolveBatchTemplateId } from "@/klip/batch-service";

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
 * dua worker yang berjalan bersamaan tidak boleh mengambil baris yang sama
 * (T2-3). Job dengan next_attempt_at di masa depan dilewati sampai waktunya.
 *
 * `batchId` hanya dipakai tes untuk mengunci pencarian ke batch miliknya;
 * worker sungguhan memanggilnya tanpa argumen agar mengambil job mana pun.
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
export async function refreshBatchCounters({ batchId }: { batchId: string }): Promise<void> {
	const rows = await db
		.select({ status: klipBatchJobs.status })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.batchId, batchId));
	const total = rows.length;
	const done = rows.filter((r) => r.status === "rendered" || r.status === "published").length;
	const failed = rows.filter((r) => r.status === "failed" || r.status === "cancelled").length;
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
 * Daftarkan berkas video sebagai media project di klip_sync_media.
 *
 * Idempoten: menjalankan ulang job yang sama tidak boleh membuat baris ganda,
 * karena id-nya deterministik dari nama entri.
 */
export function newMediaAssetId(): string {
	return `m_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function registerSyncMedia({
	assetId,
	projectId,
	relPath,
	entryName,
}: {
	assetId: string;
	projectId: string;
	relPath: string;
	entryName: string;
}): Promise<void> {
	const mime = mimeForName({ name: entryName });
	// Idempoten: menjalankan ulang job yang sama tidak boleh menggandakan baris.
	const existing = await db
		.select({ id: klipSyncMedia.id })
		.from(klipSyncMedia)
		.where(and(eq(klipSyncMedia.id, assetId), eq(klipSyncMedia.projectId, projectId)))
		.limit(1);
	if (existing[0]) return;
	await db.insert(klipSyncMedia).values({
		id: assetId,
		projectId,
		filePath: relPath,
		mime,
		size: 0,
	});
}

function mimeForName({ name }: { name: string }): string {
	const ext = path.extname(name).toLowerCase();
	if (ext === ".mov") return "video/quicktime";
	if (ext === ".webm") return "video/webm";
	return "video/mp4";
}

/**
 * Simpan project ke klip_sync_projects supaya bisa dibuka di editor, lalu buat
 * baris klip_projects yang menautkannya (jalur yang sama dengan by-opencut).
 */
async function persistProject({
	opencutRef,
	name,
	data,
}: {
	opencutRef: string;
	name: string;
	data: string;
}): Promise<string> {
	const existing = await db
		.select({ id: klipSyncProjects.id })
		.from(klipSyncProjects)
		.where(eq(klipSyncProjects.id, opencutRef))
		.limit(1);
	if (existing[0]) {
		await db
			.update(klipSyncProjects)
			.set({ name: name.slice(0, 255), data, updatedAt: new Date() })
			.where(eq(klipSyncProjects.id, opencutRef));
	} else {
		await db
			.insert(klipSyncProjects)
			.values({ id: opencutRef, name: name.slice(0, 255), data });
	}
	const project = await resolveOrCreateProject({ opencutRef, name });
	return project.id;
}

export type ProcessResult =
	| { kind: "rendered"; projectId: string; video: string }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; error: string; willRetry: boolean };

/**
 * Kerjakan satu job: ekstrak ZIP batch (sekali per batch), ambil video yang
 * cocok dengan entryName, bangun project, simpan, lalu tempelkan template.
 */
export async function processJob({ job }: { job: ClaimedJob }): Promise<ProcessResult> {
	const batches = await db
		.select()
		.from(klipBatches)
		.where(eq(klipBatches.id, job.batchId))
		.limit(1);
	const batch = batches[0];
	if (!batch) return { kind: "failed", error: "batch not found", willRetry: false };

	await setJob({ id: job.id, values: { status: "extracting" } });
	const zipAbsPath = path.join(dataRoot(), batch.zipPath);
	const { videos, skipped } = await extractVideosFromZip({
		zipAbsPath,
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

	const opencutRef = randomUUID();
	// mediaId harus diketahui saat project dibangun, jadi id-nya dibuat lebih
	// dulu. Baris klip_sync_media baru bisa ditulis SETELAH klip_sync_projects
	// ada, karena foreign key-nya ke sana.
	const mediaAssetId = newMediaAssetId();
	const project = buildProjectFromVideo({
		video: {
			name: video.entryName,
			absPath: video.absPath,
			width: video.width,
			height: video.height,
			duration: video.duration,
		},
		projectId: opencutRef,
		mediaAssetId,
	});
	const projectId = await persistProject({
		opencutRef,
		name: project.metadata.name,
		data: serializeProjectForServer({ project }),
	});
	// Baru sekarang project-nya ada, jadi media boleh didaftarkan.
	await registerSyncMedia({
		assetId: mediaAssetId,
		projectId: opencutRef,
		relPath: video.relPath,
		entryName: video.entryName,
	});

	await setJob({ id: job.id, values: { projectId, stage: "project_created" } });

	// Tempelkan template. mainDuration diambil dari durasi video supaya layer
		// anchor "di akhir video" mendarat tepat di ujung.
	const templateId = await resolveBatchTemplateId({
		explicitTemplateId: batch.templateId,
	});
	if (templateId) {
		try {
			const applied = await applyTemplate({
				projectId,
				templateId,
				mainDuration: video.duration,
			});
			if (applied.status !== 200) {
				throw new Error(applied.error);
			}
			await setJob({ id: job.id, values: { stage: "template_applied" } });
		} catch (error) {
			// Project sudah jadi; template gagal jangan membuang hasilnya.
			const message = error instanceof Error ? error.message : "template failed";
			await setJob({ id: job.id, values: { error: `template: ${message}` } });
		}
	}

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
	return { kind: "rendered", projectId, video: video.entryName };
}
