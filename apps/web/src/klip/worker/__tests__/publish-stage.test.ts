import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
	db,
	klipBatchJobs,
	klipBatches,
	klipIgAccounts,
	klipProjects,
	klipSettings,
} from "@/db";
import { SETTING_KEYS, setSetting } from "@/klip/settings";
import { isRateLimitError } from "@/klip/worker/publish";
import {
	claimNextJob,
	maybeHaltBatch,
	processJob,
	refreshBatchCounters,
} from "@/klip/worker/process";
import type { ChromiumRunner } from "@/klip/worker/chromium";

/**
 * Tahap 4: publish otomatis.
 *
 * Tes ini sengaja TIDAK memanggil Instagram dan TIDAK menjalankan Chromium.
 * Yang diuji adalah keputusan worker: kapan merender ulang, kapan berhenti,
 * dan kapan batch dimatikan.
 */

const batchIds: string[] = [];
const projectIds: string[] = [];
const accountIds: string[] = [];
const jobIds: string[] = [];
let dataDir = "";
let savedDefaultIg: string | null = null;
let savedThreshold: string | null = null;

/** Runner palsu: meledak kalau worker mencoba merender. */
function explodingRunner(): { runner: ChromiumRunner; calls: () => number } {
	let calls = 0;
	// Pengganti ChromiumRunner: tes ini tidak boleh membuka browser sama sekali.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tiruan parsial, hanya dua method yang dipakai processJob
	const runner = {
		renderProject: async () => {
			calls += 1;
			throw new Error("renderProject dipanggil padahal render sudah ada");
		},
		close: async () => {},
	} as unknown as ChromiumRunner;
	return { runner, calls: () => calls };
}

let seq = 0;
function newId({ prefix }: { prefix: string }): string {
	seq += 1;
	return `${prefix}_t${Date.now().toString(36)}${seq}`;
}

async function makeProject(): Promise<string> {
	const id = newId({ prefix: "proj" });
	await db.insert(klipProjects).values({
		id,
		name: `uji ${id}`,
		opencutRef: `ref-${id}`,
	});
	projectIds.push(id);
	return id;
}

async function makeAccount({
	status,
}: {
	status: "active" | "token_expired";
}): Promise<string> {
	const id = newId({ prefix: "ig" });
	await db.insert(klipIgAccounts).values({
		id,
		igUserId: `igu-${id}`,
		username: `uji_${id}`,
		// Sengaja bukan ciphertext yang sah: dekripsi akan gagal, dan itulah
		// yang membuat tahap publish berakhir "failed" tanpa menyentuh jaringan.
		accessTokenEnc: "bukan:ciphertext:sah",
		status,
	});
	accountIds.push(id);
	return id;
}

async function makeBatch({
	igAccountId = null,
	caption = null,
}: {
	igAccountId?: string | null;
	caption?: string | null;
} = {}): Promise<string> {
	const id = newId({ prefix: "batch" });
	await db.insert(klipBatches).values({
		id,
		ownerUserId: "app:ordo",
		zipPath: "batch-source/palsu.zip",
		status: "running",
		igAccountId,
		caption,
	});
	batchIds.push(id);
	return id;
}

async function makeJob({
	batchId,
	status = "queued",
	stage = null,
	projectId = null,
	renderedPath = null,
	entryName = "clip.mp4",
}: {
	batchId: string;
	status?: "queued" | "rendered" | "failed" | "publishing";
	stage?: string | null;
	projectId?: string | null;
	renderedPath?: string | null;
	entryName?: string;
}): Promise<string> {
	const id = newId({ prefix: "job" });
	await db.insert(klipBatchJobs).values({
		id,
		batchId,
		entryName,
		status,
		stage,
		projectId,
		renderedPath,
		attempts: 0,
		maxAttempts: 5,
	});
	jobIds.push(id);
	return id;
}

async function readJob({ id }: { id: string }) {
	const rows = await db
		.select()
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.id, id))
		.limit(1);
	return rows[0];
}

async function readBatch({ id }: { id: string }) {
	const rows = await db
		.select()
		.from(klipBatches)
		.where(eq(klipBatches.id, id))
		.limit(1);
	return rows[0];
}

beforeAll(async () => {
	process.env.APP_USER = "ordo";
	process.env.KLIP_DATA_ROOT = await mkdtemp(
		path.join(tmpdir(), "klip-publish-"),
	);
	dataDir = process.env.KLIP_DATA_ROOT;
	await mkdir(path.join(dataDir, "renders"), { recursive: true });

	// Setelan nyata dipakai bersama dengan produksi lokal; simpan lalu pulihkan.
	const rows = await db.select().from(klipSettings);
	const found = new Map(rows.map((r) => [r.key, r.value]));
	savedDefaultIg = found.get(SETTING_KEYS.defaultIgAccountId) ?? null;
	savedThreshold = found.get(SETTING_KEYS.publishFailureThreshold) ?? null;
	await setSetting({ key: SETTING_KEYS.defaultIgAccountId, value: "" });
	await setSetting({ key: SETTING_KEYS.publishFailureThreshold, value: "2" });
});

afterAll(async () => {
	if (jobIds.length > 0) {
		await db
			.delete(klipBatchJobs)
			.where(inArray(klipBatchJobs.id, jobIds))
			.catch(() => {});
	}
	if (batchIds.length > 0) {
		await db
			.delete(klipBatches)
			.where(inArray(klipBatches.id, batchIds))
			.catch(() => {});
	}
	if (projectIds.length > 0) {
		await db
			.delete(klipProjects)
			.where(inArray(klipProjects.id, projectIds))
			.catch(() => {});
	}
	if (accountIds.length > 0) {
		await db
			.delete(klipIgAccounts)
			.where(inArray(klipIgAccounts.id, accountIds))
			.catch(() => {});
	}
	await setSetting({
		key: SETTING_KEYS.defaultIgAccountId,
		value: savedDefaultIg ?? "",
	});
	await setSetting({
		key: SETTING_KEYS.publishFailureThreshold,
		value: savedThreshold ?? "2",
	});
	if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("publish otomatis", () => {
	test("job yang sudah punya berkas render tidak dirender ulang", async () => {
		const batchId = await makeBatch();
		const projectId = await makeProject();
		const rendered = path.join("renders", "sudah-ada.mp4");
		await writeFile(path.join(dataDir, rendered), Buffer.from("mp4 palsu"));
		const jobId = await makeJob({
			batchId,
			projectId,
			renderedPath: rendered,
			status: "rendered",
		});

		const { runner, calls } = explodingRunner();
		const result = await processJob({
			job: {
				id: jobId,
				batchId,
				entryName: "clip.mp4",
				attempts: 0,
				maxAttempts: 5,
				projectId,
			},
			runner,
			baseUrl: "http://127.0.0.1:6050",
		});

		expect(calls()).toBe(0);
		// Tanpa akun IG tujuan, publish dilewati - dan itu BUKAN kegagalan.
		expect(result.kind).toBe("rendered");
		const job = await readJob({ id: jobId });
		expect(job?.stage).toBe("no_ig_account");
		expect(job?.status).toBe("rendered");
	});

	test("publish gagal: tahap publish_failed, bukan dirender ulang", async () => {
		const accountId = await makeAccount({ status: "active" });
		const batchId = await makeBatch({
			igAccountId: accountId,
			caption: "caption uji",
		});
		const projectId = await makeProject();
		// Berkas sengaja tidak dibuat: publish gagal di baca berkas, jadi tidak
		// ada permintaan jaringan sama sekali.
		const jobId = await makeJob({
			batchId,
			projectId,
			renderedPath: path.join("renders", "hilang.mp4"),
			status: "rendered",
		});

		const { runner, calls } = explodingRunner();
		await expect(
			processJob({
				job: {
					id: jobId,
					batchId,
					entryName: "clip.mp4",
					attempts: 0,
					maxAttempts: 5,
					projectId,
				},
				runner,
				baseUrl: "http://127.0.0.1:6050",
			}),
		).rejects.toThrow();

		expect(calls()).toBe(0);
		const job = await readJob({ id: jobId });
		expect(job?.stage).toBe("publish_failed");
		expect(job?.status).not.toBe("published");
	});

	test("dua kegagalan publish berturut-turut menghentikan batch", async () => {
		const accountId = await makeAccount({ status: "active" });
		const batchId = await makeBatch({ igAccountId: accountId });
		const { runner } = explodingRunner();

		for (let i = 0; i < 2; i += 1) {
			const projectId = await makeProject();
			const jobId = await makeJob({
				batchId,
				projectId,
				renderedPath: path.join("renders", `hilang-${i}.mp4`),
				status: "rendered",
			});
			await expect(
				processJob({
					job: {
						id: jobId,
						batchId,
						entryName: "clip.mp4",
						attempts: 0,
						maxAttempts: 5,
						projectId,
					},
					runner,
					baseUrl: "http://127.0.0.1:6050",
				}),
			).rejects.toThrow();
		}

		const batch = await readBatch({ id: batchId });
		expect(batch?.status).toBe("halted");
		expect(batch?.haltedReason ?? "").toContain("berturut-turut");
	});

	test("kegagalan karena batas laju tidak menghentikan batch", async () => {
		const batchId = await makeBatch();
		await makeJob({ batchId, status: "failed", stage: "publish_rate_limited" });
		await makeJob({ batchId, status: "failed", stage: "publish_rate_limited" });
		await maybeHaltBatch({ batchId, rateLimited: false });
		expect((await readBatch({ id: batchId }))?.status).toBe("running");
	});

	test("satu gagal isi + satu batas laju belum cukup untuk menghentikan", async () => {
		const batchId = await makeBatch();
		await makeJob({ batchId, status: "failed", stage: "publish_failed" });
		await makeJob({ batchId, status: "failed", stage: "publish_rate_limited" });
		await maybeHaltBatch({ batchId, rateLimited: false });
		expect((await readBatch({ id: batchId }))?.status).toBe("running");
	});

	test("kegagalan render tidak dihitung sebagai kegagalan publish", async () => {
		const batchId = await makeBatch();
		await makeJob({ batchId, status: "failed", stage: "render_done" });
		await makeJob({ batchId, status: "failed", stage: "project_created" });
		await maybeHaltBatch({ batchId, rateLimited: false });
		expect((await readBatch({ id: batchId }))?.status).toBe("running");
	});

	test("batch yang dihentikan tidak diambil lagi oleh worker", async () => {
		const batchId = await makeBatch();
		const jobId = await makeJob({ batchId, status: "queued" });
		await db
			.update(klipBatches)
			.set({ status: "halted" })
			.where(eq(klipBatches.id, batchId));

		expect(await claimNextJob({ batchId })).toBeNull();

		// Setelah dijalankan ulang manual, job itu boleh dikerjakan lagi.
		await db
			.update(klipBatches)
			.set({ status: "running" })
			.where(eq(klipBatches.id, batchId));
		const claimed = await claimNextJob({ batchId });
		expect(claimed?.id).toBe(jobId);
	});

	test("status halted tidak ditimpa oleh hitung ulang counter", async () => {
		const batchId = await makeBatch();
		await makeJob({ batchId, status: "rendered", stage: "no_ig_account" });
		await db
			.update(klipBatches)
			.set({ status: "halted", haltedReason: "uji" })
			.where(eq(klipBatches.id, batchId));

		await refreshBatchCounters({ batchId });

		const batch = await readBatch({ id: batchId });
		expect(batch?.status).toBe("halted");
		// Hitungannya tetap diperbarui walau statusnya dibekukan.
		expect(batch?.succeeded).toBe(1);
		expect(batch?.total).toBe(1);
	});
});

describe("pengenalan kegagalan batas laju", () => {
	test("pesan batas laju dikenali", () => {
		expect(isRateLimitError({ message: "Rate limit reached" })).toBe(true);
		expect(isRateLimitError({ message: "HTTP 429 Too Many Requests" })).toBe(
			true,
		);
		expect(isRateLimitError({ message: "User is temporarily blocked" })).toBe(
			true,
		);
	});

	test("pesan ASLI Meta dikenali", () => {
		// Inilah pesan yang benar-benar muncul di produksi dan sebelumnya LOLOS
		// dari pemeriksaan, sehingga batas laju dihitung sebagai kegagalan konten.
		expect(
			isRateLimitError({
				message:
					"Instagram API gagal [GET /17905270827559278]: Application request limit reached",
			}),
		).toBe(true);
		expect(
			isRateLimitError({ message: "Application request limit reached" }),
		).toBe(true);
		expect(isRateLimitError({ message: "User request limit reached" })).toBe(
			true,
		);
		// Kode kesalahan Meta untuk batas laju.
		expect(
			isRateLimitError({ message: '{"error":{"code":4,"message":"x"}}' }),
		).toBe(true);
		expect(
			isRateLimitError({ message: '{"error":{"code":613,"message":"x"}}' }),
		).toBe(true);
		expect(isRateLimitError({ message: "API call limit exceeded" })).toBe(true);
	});

	test("kode kesalahan lain TIDAK dianggap batas laju", () => {
		// 100 = parameter tidak valid; muncul saat video_url tidak dikirim.
		expect(
			isRateLimitError({ message: '{"error":{"code":100,"message":"x"}}' }),
		).toBe(false);
		expect(
			isRateLimitError({ message: '{"error":{"code":190,"message":"token"}}' }),
		).toBe(false);
	});

	test("kegagalan biasa tidak dianggap batas laju", () => {
		expect(
			isRateLimitError({ message: "ENOENT: no such file or directory" }),
		).toBe(false);
		expect(
			isRateLimitError({ message: "IG_TOKEN_INVALID: token kedaluwarsa" }),
		).toBe(false);
		expect(isRateLimitError({ message: "Video terlalu pendek" })).toBe(false);
	});
});
