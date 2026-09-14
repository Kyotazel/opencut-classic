import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches, klipSettings } from "@/db";
import { retryFailedJobsInBatch, retryJob } from "@/klip/batch-retry";
import { SETTING_KEYS, setSetting } from "@/klip/settings";
import { processJob } from "@/klip/worker/process";
import type { ChromiumRunner } from "@/klip/worker/chromium";

/**
 * Menjalankan ulang job + circuit breaker untuk kegagalan render.
 *
 * Tidak memanggil Instagram, tidak menjalankan Chromium. Kegagalan render
 * dipaksa lewat ZIP yang sengaja tidak ada - worker gagal di tahap ekstraksi,
 * yang dihitung sebagai kegagalan render.
 */

const batchIds: string[] = [];
const jobIds: string[] = [];
let dataDir = "";
let savedThreshold: string | null = null;

function stubRunner(): ChromiumRunner {
	// Runner tidak pernah dipakai di tes ini: kegagalan terjadi sebelum render.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tiruan kosong
	return {
		renderProject: async () => {
			throw new Error("renderProject tidak seharusnya dipanggil");
		},
		close: async () => {},
	} as unknown as ChromiumRunner;
}

let seq = 0;
function newId({ prefix }: { prefix: string }): string {
	seq += 1;
	return `${prefix}_tz${Date.now().toString(36)}${seq}`;
}

async function makeBatch({
	status = "running",
	zipPath = "batch-source/tidak-ada.zip",
}: {
	status?: "queued" | "running" | "done" | "partial" | "failed" | "halted";
	zipPath?: string;
} = {}): Promise<string> {
	const id = newId({ prefix: "batch" });
	await db.insert(klipBatches).values({
		id,
		ownerUserId: "app:ordo",
		zipPath,
		status,
		haltedReason: status === "halted" ? "uji" : null,
	});
	batchIds.push(id);
	return id;
}

async function makeJob({
	batchId,
	status = "failed",
	stage = null,
	attempts = 4,
	renderedPath = null,
}: {
	batchId: string;
	status?: "queued" | "failed" | "cancelled" | "rendered" | "published";
	stage?: string | null;
	attempts?: number;
	renderedPath?: string | null;
}): Promise<string> {
	const id = newId({ prefix: "job" });
	await db.insert(klipBatchJobs).values({
		id,
		batchId,
		entryName: "clip.mp4",
		status,
		stage,
		attempts,
		maxAttempts: 5,
		renderedPath,
		error: "kegagalan sebelumnya",
		lockedAt: new Date(),
		lockedBy: "worker-lama",
	});
	jobIds.push(id);
	return id;
}

async function readJob({ id }: { id: string }) {
	const rows = await db.select().from(klipBatchJobs).where(eq(klipBatchJobs.id, id)).limit(1);
	return rows[0];
}

async function readBatch({ id }: { id: string }) {
	const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, id)).limit(1);
	return rows[0];
}

beforeAll(async () => {
	process.env.APP_USER = "ordo";
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-retry-"));
	dataDir = process.env.KLIP_DATA_ROOT;

	const rows = await db.select().from(klipSettings);
	const found = new Map(rows.map((r) => [r.key, r.value]));
	savedThreshold = found.get(SETTING_KEYS.publishFailureThreshold) ?? null;
	await setSetting({ key: SETTING_KEYS.publishFailureThreshold, value: "2" });
});

afterAll(async () => {
	if (jobIds.length > 0) {
		await db.delete(klipBatchJobs).where(inArray(klipBatchJobs.id, jobIds)).catch(() => {});
	}
	if (batchIds.length > 0) {
		await db.delete(klipBatches).where(inArray(klipBatches.id, batchIds)).catch(() => {});
	}
	await setSetting({
		key: SETTING_KEYS.publishFailureThreshold,
		value: savedThreshold ?? "2",
	});
	if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("menjalankan ulang job", () => {
	test("attempts kembali 0 dan status kembali queued", async () => {
		const batchId = await makeBatch();
		const jobId = await makeJob({ batchId, status: "failed", attempts: 4, stage: "render_failed" });

		const result = await retryJob({ jobId });

		expect(result.retried).toEqual([jobId]);
		const job = await readJob({ id: jobId });
		expect(job?.attempts).toBe(0);
		expect(job?.status).toBe("queued");
		expect(job?.stage).toBeNull();
		expect(job?.error).toBeNull();
		// Kunci lama harus dilepas, kalau tidak worker tidak akan mengambilnya.
		expect(job?.lockedAt).toBeNull();
	});

	test("hasil render dipertahankan supaya publish tidak merender ulang", async () => {
		const batchId = await makeBatch();
		const jobId = await makeJob({
			batchId,
			status: "failed",
			stage: "publish_failed",
			renderedPath: "renders/sudah-ada.mp4",
		});

		await retryJob({ jobId });

		expect((await readJob({ id: jobId }))?.renderedPath).toBe("renders/sudah-ada.mp4");
	});

	test("fresh membuang hasil render", async () => {
		const batchId = await makeBatch();
		const jobId = await makeJob({
			batchId,
			status: "failed",
			stage: "publish_failed",
			renderedPath: "renders/sudah-ada.mp4",
		});

		await retryJob({ jobId, fresh: true });

		expect((await readJob({ id: jobId }))?.renderedPath).toBeNull();
	});

	test("batch yang halted dibuka lagi, kalau tidak job mengantri selamanya", async () => {
		const batchId = await makeBatch({ status: "halted" });
		const jobId = await makeJob({ batchId, status: "failed" });

		await retryJob({ jobId });

		const batch = await readBatch({ id: batchId });
		expect(batch?.status).toBe("running");
		expect(batch?.haltedReason).toBeNull();
	});

	test("job yang tidak bisa diulang ditolak dengan alasan", async () => {
		const batchId = await makeBatch();
		const jobId = await makeJob({ batchId, status: "published" });
		// published bukan status yang diizinkan.
		const result = await retryJob({ jobId });
		expect(result.retried).toEqual([]);
	});

	test("ulangi semua yang gagal hanya menyentuh yang gagal", async () => {
		const batchId = await makeBatch();
		const gagal = await makeJob({ batchId, status: "failed" });
		const dibatalkan = await makeJob({ batchId, status: "cancelled" });
		const terbit = await makeJob({ batchId, status: "published" });
		const menunggu = await makeJob({ batchId, status: "queued" });

		const result = await retryFailedJobsInBatch({ batchId });

		expect(result.retried.sort()).toEqual([gagal, dibatalkan].sort());
		expect((await readJob({ id: terbit }))?.status).toBe("published");
		expect((await readJob({ id: menunggu }))?.status).toBe("queued");
	});
});

describe("circuit breaker untuk kegagalan render", () => {
	test("dua kegagalan render berturut-turut menghentikan batch", async () => {
		const batchId = await makeBatch();

		for (let i = 0; i < 2; i += 1) {
			const jobId = await makeJob({ batchId, status: "failed", attempts: 0 });
			// ZIP tidak ada -> worker gagal di tahap ekstraksi, sebelum render.
			await expect(
				processJob({
					job: {
						id: jobId,
						batchId,
						entryName: "clip.mp4",
						attempts: 0,
						maxAttempts: 5,
						projectId: null,
					},
					runner: stubRunner(),
					baseUrl: "http://127.0.0.1:6050",
				}),
			).rejects.toThrow();

			// Tahapnya harus tertulis, kalau tidak breaker tidak bisa menghitung.
			expect((await readJob({ id: jobId }))?.stage).toBe("render_failed");
		}

		const batch = await readBatch({ id: batchId });
		expect(batch?.status).toBe("halted");
		expect(batch?.haltedReason ?? "").toContain("berturut-turut");
	});
});
