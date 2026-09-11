import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
	db,
	klipBatchJobs,
	klipBatches,
	klipProjects,
	klipSyncProjects,
} from "@/db";
import { ensureWasmLoaded } from "@/wasm/node-loader";
import { extractVideosFromZip } from "@/klip/worker/extract";
import { buildProjectFromVideo } from "@/klip/worker/project-builder";
import { claimNextJob, processJob, refreshBatchCounters } from "@/klip/worker/process";
import { nextRetryAt } from "@/klip/worker/loop";

let fixtureDir = "";
let zipPath = "";
let mixedZipPath = "";
const createdBatchIds: string[] = [];
const createdSyncIds: string[] = [];

function makeZip({ target, entries }: { target: string; entries: string[] }): void {
	const writes = entries
		.map((name) => `    z.writestr(${JSON.stringify(name)}, bytes(64))`)
		.join("\n");
	const script = [
		"import sys, zipfile",
		"zp = sys.argv[1]",
		'with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:',
		writes,
	].join("\n");
	const proc = Bun.spawnSync(["python3", "-", target], {
		stdin: new TextEncoder().encode(script),
	});
	if (proc.exitCode !== 0) throw new Error("fixture zip gagal");
}

async function seedBatch({
	entryNames,
	templateId = null,
}: {
	entryNames: string[];
	templateId?: string | null;
}): Promise<string> {
	const id = `b_test${Math.random().toString(36).slice(2, 10)}`;
	await db.insert(klipBatches).values({
		id,
		ownerUserId: "app:test",
		templateId,
		source: "upload",
		zipPath: path.join("batches", `${id}.zip`),
		status: "queued",
		total: entryNames.length,
	});
	for (const entryName of entryNames) {
		await db.insert(klipBatchJobs).values({
			id: `j_test${Math.random().toString(36).slice(2, 10)}`,
			batchId: id,
			entryName,
			status: "queued",
			maxAttempts: 5,
		});
	}
	createdBatchIds.push(id);
	return id;
}

beforeAll(async () => {
	await ensureWasmLoaded();
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-worker-"));
	await mkdir(path.join(process.env.KLIP_DATA_ROOT, "batches"), { recursive: true });
	fixtureDir = await mkdtemp(path.join(tmpdir(), "klip-worker-fx-"));
	zipPath = path.join(fixtureDir, "batch.zip");
	makeZip({ target: zipPath, entries: ["clip-a.mp4", "clip-b.mp4"] });
	mixedZipPath = path.join(fixtureDir, "mixed.zip");
	makeZip({ target: mixedZipPath, entries: ["video.mp4", "readme.txt", "notes.md"] });
});

afterAll(async () => {
	if (createdBatchIds.length > 0) {
		await db.delete(klipBatches).where(inArray(klipBatches.id, createdBatchIds)).catch(() => {});
	}
	if (createdSyncIds.length > 0) {
		await db.delete(klipSyncProjects).where(inArray(klipSyncProjects.id, createdSyncIds)).catch(() => {});
	}
	if (process.env.KLIP_DATA_ROOT) {
		await rm(process.env.KLIP_DATA_ROOT, { recursive: true, force: true });
		delete process.env.KLIP_DATA_ROOT;
	}
	if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

describe("nextRetryAt", () => {
	test("menjadwalkan retry selama kuota belum habis", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const at = nextRetryAt({ attempts: 0, maxAttempts: 5, now });
		expect(at).not.toBeNull();
		expect(at!.getTime()).toBeGreaterThan(now.getTime());
	});

	test("berhenti menjadwalkan setelah percobaan terakhir", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		expect(nextRetryAt({ attempts: 4, maxAttempts: 5, now })).toBeNull();
		expect(nextRetryAt({ attempts: 5, maxAttempts: 5, now })).toBeNull();
	});
});

describe("extractVideosFromZip", () => {
	test("mengekstrak video dan mengabaikan non-video", async () => {
		const batchId = "b_extracttest";
		const { videos, skipped } = await extractVideosFromZip({
			zipAbsPath: mixedZipPath,
			batchId,
		});
		expect(videos.map((v) => v.entryName)).toEqual(["video.mp4"]);
		expect(skipped.map((s) => s.entryName).sort()).toEqual(["notes.md", "readme.txt"]);
		// File benar-benar ada di disk.
		expect(await Bun.file(videos[0]!.absPath).exists()).toBe(true);
		expect(videos[0]!.relPath).toContain("batch-source");
	});
});

describe("buildProjectFromVideo", () => {
	test("menyusun project dengan video di track utama", () => {
		const project = buildProjectFromVideo({
			video: {
				name: "klip-satu.mp4",
				absPath: "/tmp/klip-satu.mp4",
				width: 1080,
				height: 1920,
				duration: 12.5,
			},
			projectId: "11111111-2222-3333-4444-555555555555",
			mediaAssetId: "m_testasset",
		});
		expect(project.metadata.name).toBe("klip-satu");
		expect(project.scenes).toHaveLength(1);
		expect(project.scenes[0]!.tracks.main.elements).toHaveLength(1);
		const el = project.scenes[0]!.tracks.main.elements[0]!;
		expect(el.type).toBe("video");
		// mediaId = id klip_sync_media, karena editor memuat berkas lewat
		// /api/sync/media/<id itu>. Bukan path mentah.
		expect(el.mediaId).toBe("m_testasset");
	});

	test("durasi elemen mengikuti durasi video", () => {
		const project = buildProjectFromVideo({
			video: { name: "a.mp4", absPath: "/tmp/a.mp4", width: 1, height: 1, duration: 7 },
			projectId: "11111111-2222-3333-4444-555555555555",
			mediaAssetId: "m_testasset",
		});
		const el = project.scenes[0]!.tracks.main.elements[0]!;
		// 7 detik x 120000 tick = 840000
		expect(Number(el.duration)).toBe(840000);
	});
});

describe("klaim job", () => {
	test("mengklaim baris queued dan menandainya terkunci", async () => {
		const batchId = await seedBatch({ entryNames: ["clip-a.mp4"] });
		// Dibatasi ke batch tes ini: database lokal bisa berisi batch asli, dan
		// tes tidak boleh mengklaim pekerjaan nyata milik user.
		const job = await claimNextJob({ batchId });
		expect(job).not.toBeNull();
		expect(job!.batchId).toBe(batchId);
		const rows = await db.select().from(klipBatchJobs).where(eq(klipBatchJobs.id, job!.id));
		expect(rows[0]!.lockedAt).not.toBeNull();
		expect(rows[0]!.status).toBe("queued");
	});

	test("tidak mengklaim job yang sudah terkunci", async () => {
		const batchId = await seedBatch({ entryNames: ["clip-a.mp4", "clip-b.mp4"] });
		const first = await claimNextJob({ batchId });
		expect(first!.batchId).toBe(batchId);
		// Klaim kedua harus mendapat job LAIN di batch yang sama.
		const second = await claimNextJob({ batchId });
		expect(second).not.toBeNull();
		expect(second!.id).not.toBe(first!.id);
	});
});

describe("processJob", () => {
	test("membuat project yang bisa dibuka dan menautkannya ke job", async () => {
		const batchId = await seedBatch({ entryNames: ["clip-a.mp4"] });
		// ZIP batch harus ada di KLIP_DATA_ROOT.
		const dest = path.join(process.env.KLIP_DATA_ROOT!, "batches", `${batchId}.zip`);
		await writeFile(dest, Buffer.from(await Bun.file(zipPath).arrayBuffer()));

		const job = await claimNextJob({ batchId });
		const result = await processJob({ job: job! });
		expect(result.kind).toBe("rendered");
		if (result.kind !== "rendered") throw new Error("harus rendered");

		const jobs = await db.select().from(klipBatchJobs).where(eq(klipBatchJobs.batchId, batchId));
		expect(jobs[0]!.status).toBe("rendered");
		expect(jobs[0]!.projectId).toBe(result.projectId);
		expect(jobs[0]!.lockedAt).toBeNull();
		expect(jobs[0]!.attempts).toBe(1);

		// Project tersimpan di klip_sync_projects (kuncinya opencutRef, bukan
		// id klip_projects) dan JSON-nya valid.
		const links = await db
			.select()
			.from(klipProjects)
			.where(eq(klipProjects.id, jobs[0]!.projectId!));
		expect(links).toHaveLength(1);
		const opencutRef = links[0]!.opencutRef!;
		const sync = await db
			.select()
			.from(klipSyncProjects)
			.where(eq(klipSyncProjects.id, opencutRef));
		expect(sync).toHaveLength(1);
		createdSyncIds.push(sync[0]!.id);
		const parsed = JSON.parse(sync[0]!.data) as { metadata: { id: string }; scenes: unknown[] };
		expect(parsed.scenes).toHaveLength(1);
	});

	test("entri non-video ditandai cancelled, bukan gagal", async () => {
		const batchId = await seedBatch({ entryNames: ["readme.txt"] });
		const dest = path.join(process.env.KLIP_DATA_ROOT!, "batches", `${batchId}.zip`);
		await writeFile(dest, Buffer.from(await Bun.file(mixedZipPath).arrayBuffer()));

		const job = await claimNextJob({ batchId });
		const result = await processJob({ job: job! });
		expect(result.kind).toBe("skipped");
		const jobs = await db.select().from(klipBatchJobs).where(eq(klipBatchJobs.batchId, batchId));
		expect(jobs[0]!.status).toBe("cancelled");
		expect(jobs[0]!.error).toContain("not a video");
	});
});

describe("refreshBatchCounters", () => {
	test("menghitung ulang dari baris job, bukan menambah", async () => {
		const batchId = await seedBatch({ entryNames: ["clip-a.mp4", "clip-b.mp4"] });
		await db
			.update(klipBatchJobs)
			.set({ status: "rendered" })
			.where(eq(klipBatchJobs.batchId, batchId));
		await refreshBatchCounters({ batchId });
		const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, batchId));
		expect(rows[0]!.succeeded).toBe(2);
		expect(rows[0]!.failed).toBe(0);
		expect(rows[0]!.status).toBe("done");
	});
});
