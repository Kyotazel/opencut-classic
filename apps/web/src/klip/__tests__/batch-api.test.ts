import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, klipBatchJobs, klipBatches, klipSettings } from "@/db";
import { POST as createBatchRoute } from "@/app/api/klip/batches/route";
import { listZipEntries } from "@/klip/batch-store";
import {
	parseBoolSetting,
	parseTimeSetting,
	resolveBatchSettings,
	SETTING_DEFAULTS,
	SETTING_KEYS,
} from "@/klip/settings";

const createdBatchIds: string[] = [];
let fixtureDir = "";
let zipPath = "";
let emptyZipPath = "";
let traversalZipPath = "";

function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	return new Request(url, init) as unknown as NextRequest;
}

function makeZip({ target, entries }: { target: string; entries: string[] }): void {
	// Entri dibangun di sisi Python lewat argv; script-nya statis.
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
	if (proc.exitCode !== 0) throw new Error("fixture zip failed: " + new TextDecoder().decode(proc.stderr));
}

function multipartReq({ file, templateId }: { file: File; templateId?: string }): NextRequest {
	const form = new FormData();
	form.append("file", file);
	if (templateId) form.append("templateId", templateId);
	return req({ url: "http://localhost/api/klip/batches", init: { method: "POST", body: form } });
}

beforeAll(async () => {
	// Owner berasal dari env (keputusan #6 revisi), bukan tabel users.
	process.env.APP_USER = "ordo";
	delete process.env.KLIP_OWNER_ID;
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-batches-"));
	fixtureDir = await mkdtemp(path.join(tmpdir(), "klip-batches-fixture-"));
	zipPath = path.join(fixtureDir, "batch.zip");
	makeZip({
		target: zipPath,
		entries: ["clip-a.mp4", "clip-b.mp4", "nested/clip-c.mov", "notes.txt", "__MACOSX/._a.mp4"],
	});
	emptyZipPath = path.join(fixtureDir, "empty.zip");
	makeZip({ target: emptyZipPath, entries: ["docs/"] });
	traversalZipPath = path.join(fixtureDir, "evil.zip");
	makeZip({ target: traversalZipPath, entries: ["../../evil.mp4"] });
});

afterAll(async () => {
	if (createdBatchIds.length > 0) {
		// Jobs ikut terhapus via ON DELETE CASCADE.
		await db.delete(klipBatches).where(inArray(klipBatches.id, createdBatchIds)).catch(() => {});
	}
	await db.delete(klipSettings).where(inArray(klipSettings.key, Object.values(SETTING_KEYS))).catch(() => {});
	if (process.env.KLIP_DATA_ROOT) {
		await rm(process.env.KLIP_DATA_ROOT, { recursive: true, force: true });
		delete process.env.KLIP_DATA_ROOT;
	}
	if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

describe("setting readers", () => {
	test("parseBoolSetting accepts common truthy spellings only", () => {
		for (const v of ["1", "true", "YES", " on "]) expect(parseBoolSetting({ value: v })).toBe(true);
		for (const v of ["0", "false", "", "no", "2"]) expect(parseBoolSetting({ value: v })).toBe(false);
	});

	test("parseTimeSetting rejects malformed clock values", () => {
		expect(parseTimeSetting({ value: "11:00" })).toEqual({ hour: 11, minute: 0 });
		expect(parseTimeSetting({ value: "15:30" })).toEqual({ hour: 15, minute: 30 });
		// "15:0" dan "25:00" adalah alasan key-value wajib divalidasi.
		expect(parseTimeSetting({ value: "15:0" })).toBeNull();
		expect(parseTimeSetting({ value: "25:00" })).toBeNull();
		expect(parseTimeSetting({ value: "ab:cd" })).toBeNull();
	});

	test("resolveBatchSettings falls back to documented defaults", async () => {
		await db.delete(klipSettings).where(inArray(klipSettings.key, Object.values(SETTING_KEYS)));
		const s = await resolveBatchSettings();
		expect(s.windowEnabled).toBe(false);
		expect(s.windowStart).toEqual({ hour: 11, minute: 0 });
		expect(s.windowEnd).toEqual({ hour: 15, minute: 0 });
		expect(s.allowManualRun).toBe(true);
		expect(s.publishFailureThreshold).toBe(2);
		expect(s.defaultTemplateId).toBeNull();
		expect(SETTING_DEFAULTS[SETTING_KEYS.renderWindowStart]).toBe("11:00");
	});
});

describe("listZipEntries", () => {
	test("lists usable video entries and drops junk", async () => {
		const entries = await listZipEntries({ absPath: zipPath });
		expect(entries.map((e) => e.name).sort()).toEqual([
			"clip-a.mp4",
			"clip-b.mp4",
			"clip-c.mov",
			"notes.txt",
		]);
	});

	test("rejects a zip with no usable entries", async () => {
		await expect(listZipEntries({ absPath: emptyZipPath })).rejects.toThrow(/no usable entries/i);
	});

	test("rejects a zip containing traversal entries", async () => {
		await expect(listZipEntries({ absPath: traversalZipPath })).rejects.toThrow(/unsafe/i);
	});
});

describe("owner resolution dari env", () => {
	// Login app ini memakai APP_USER (cookie HMAC), bukan Better Auth, jadi
	// tabel users kosong. Owner diambil dari env supaya sumbernya tunggal.
	test("memakai KLIP_OWNER_ID kalau diisi", async () => {
		process.env.KLIP_OWNER_ID = "batchsvc";
		try {
			const buf = await Bun.file(zipPath).arrayBuffer();
			const res = await createBatchRoute(
				multipartReq({ file: new File([buf], "batch.zip", { type: "application/zip" }) }),
			);
			expect(res.status).toBe(202);
			const body = (await res.json()) as { batchId: string };
			createdBatchIds.push(body.batchId);
			const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, body.batchId));
			expect(rows[0]!.ownerUserId).toBe("app:batchsvc");
		} finally {
			delete process.env.KLIP_OWNER_ID;
		}
	});

	test("jatuh ke APP_USER kalau KLIP_OWNER_ID kosong", async () => {
		delete process.env.KLIP_OWNER_ID;
		process.env.APP_USER = "ordo";
		const buf = await Bun.file(zipPath).arrayBuffer();
		const res = await createBatchRoute(
			multipartReq({ file: new File([buf], "batch.zip", { type: "application/zip" }) }),
		);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { batchId: string };
		createdBatchIds.push(body.batchId);
		const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, body.batchId));
		expect(rows[0]!.ownerUserId).toBe("app:ordo");
	});

	test("menolak 409 kalau env owner tidak ada sama sekali", async () => {
		const savedUser = process.env.APP_USER;
		delete process.env.KLIP_OWNER_ID;
		delete process.env.APP_USER;
		try {
			const buf = await Bun.file(zipPath).arrayBuffer();
			const res = await createBatchRoute(
				multipartReq({ file: new File([buf], "batch.zip", { type: "application/zip" }) }),
			);
			expect(res.status).toBe(409);
			// Tidak boleh ada baris batch yang tertinggal.
			const body = (await res.json()) as { error: string };
			expect(body.error).toMatch(/owner/i);
		} finally {
			if (savedUser) process.env.APP_USER = savedUser;
		}
	});
});

describe("POST /api/klip/batches (multipart)", () => {
	test("records a queued batch with one job per usable entry", async () => {
		const buf = await Bun.file(zipPath).arrayBuffer();
		const res = await createBatchRoute(
			multipartReq({ file: new File([buf], "batch.zip", { type: "application/zip" }) }),
		);
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			batchId: string;
			status: string;
			jobCount: number;
			templateId: string | null;
		};
		createdBatchIds.push(body.batchId);
		expect(body.batchId.startsWith("b_")).toBe(true);
		expect(body.status).toBe("queued");
		expect(body.jobCount).toBe(4);
		expect(body.templateId).toBeNull();

		const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, body.batchId));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("queued");
		expect(rows[0]!.total).toBe(4);
		expect(rows[0]!.source).toBe("upload");
		expect(rows[0]!.ownerUserId).toBeTruthy();
		expect(rows[0]!.zipPath).toContain("batches/");

		const jobs = await db.select().from(klipBatchJobs).where(eq(klipBatchJobs.batchId, body.batchId));
		expect(jobs).toHaveLength(4);
		for (const job of jobs) {
			expect(job.status).toBe("queued");
			expect(job.attempts).toBe(0);
			expect(job.maxAttempts).toBe(5);
			expect(job.projectId).toBeNull();
		}
	});

	test("stores the zip on disk rather than in memory", async () => {
		const rows = await db
			.select()
			.from(klipBatches)
			.where(eq(klipBatches.id, createdBatchIds[createdBatchIds.length - 1]!));
		const rel = rows[0]!.zipPath;
		const abs = path.join(process.env.KLIP_DATA_ROOT!, rel);
		expect(await Bun.file(abs).exists()).toBe(true);
	});

	test("keeps an explicit templateId", async () => {
		const buf = await Bun.file(zipPath).arrayBuffer();
		const res = await createBatchRoute(
			multipartReq({
				file: new File([buf], "batch.zip", { type: "application/zip" }),
				templateId: "btpl_explicit001",
			}),
		);
		const body = (await res.json()) as { batchId: string; templateId: string | null };
		createdBatchIds.push(body.batchId);
		expect(body.templateId).toBe("btpl_explicit001");
	});

	test("rejects non-zip and corrupt bodies", async () => {
		const notZip = await createBatchRoute(
			multipartReq({ file: new File([new Uint8Array([1, 2, 3])], "x.mp4", { type: "video/mp4" }) }),
		);
		expect(notZip.status).toBe(400);

		const corrupt = await createBatchRoute(
			multipartReq({ file: new File([new Uint8Array([1, 2, 3, 4])], "x.zip", { type: "application/zip" }) }),
		);
		expect(corrupt.status).toBe(400);
	});

	test("rejects a zip with traversal entries and leaves no batch row", async () => {
		const before = await db.select({ id: klipBatches.id }).from(klipBatches);
		const buf = await Bun.file(traversalZipPath).arrayBuffer();
		const res = await createBatchRoute(
			multipartReq({ file: new File([buf], "evil.zip", { type: "application/zip" }) }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/unsafe/i);
		const after = await db.select({ id: klipBatches.id }).from(klipBatches);
		expect(after.length).toBe(before.length);
	});
});

describe("POST /api/klip/batches (zip_url)", () => {
	let server: Server;
	let baseUrl = "";

	beforeAll(async () => {
		const zipBytes = Buffer.from(await Bun.file(zipPath).arrayBuffer());
		server = createServer((req, res) => {
			if (req.url === "/batch.zip") {
				res.writeHead(200, { "content-type": "application/zip" });
				res.end(zipBytes);
				return;
			}
			if (req.url === "/missing.zip") {
				res.writeHead(404);
				res.end("nope");
				return;
			}
			if (req.url === "/empty.zip") {
				res.writeHead(200, { "content-type": "application/zip" });
				res.end("");
				return;
			}
			if (req.url === "/notzip.txt") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("hello");
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function jsonReq(body: unknown): NextRequest {
		return req({
			url: "http://localhost/api/klip/batches",
			init: {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		});
	}

	test("fetches the zip from zip_url and queues jobs", async () => {
		const res = await createBatchRoute(jsonReq({ zip_url: `${baseUrl}/batch.zip` }));
		expect(res.status).toBe(202);
		const body = (await res.json()) as { batchId: string; jobCount: number; status: string };
		createdBatchIds.push(body.batchId);
		expect(body.jobCount).toBe(4);
		expect(body.status).toBe("queued");
		const rows = await db.select().from(klipBatches).where(eq(klipBatches.id, body.batchId));
		expect(rows[0]!.source).toBe("api");
	});

	test("requires zip_url", async () => {
		const res = await createBatchRoute(jsonReq({}));
		expect(res.status).toBe(400);
	});

	test("surfaces an upstream HTTP failure as 400", async () => {
		const res = await createBatchRoute(jsonReq({ zip_url: `${baseUrl}/missing.zip` }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/404/);
	});

	test("rejects a non-zip url and an empty body", async () => {
		const notZip = await createBatchRoute(jsonReq({ zip_url: `${baseUrl}/notzip.txt` }));
		expect(notZip.status).toBe(400);
		const empty = await createBatchRoute(jsonReq({ zip_url: `${baseUrl}/empty.zip` }));
		expect(empty.status).toBe(400);
	});
});
