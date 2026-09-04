import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, klipMedia } from "@/db";
import { POST as uploadBatch } from "@/app/api/uploads/batch/route";
import { sanitizeZipEntryName } from "@/klip/batch-upload";

const createdMediaIds: string[] = [];
let fixtureDir = "";
let zipPath = "";

function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	return new Request(url, init) as unknown as NextRequest;
}

beforeAll(async () => {
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-batch-"));
	fixtureDir = await mkdtemp(path.join(tmpdir(), "klip-batch-fixture-"));
	zipPath = path.join(fixtureDir, "batch.zip");
	// Fixture dibuat via python zipfile agar bisa menyertakan entri traversal.
	const script = [
		"import sys, zipfile",
		"zp = sys.argv[1]",
		'with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:',
		'    z.writestr("clip-a.mp4", bytes(2048))',
		'    z.writestr("clip-b.mp4", bytes(2048))',
		'    z.writestr("nested/clip-c.mov", bytes(2048))',
		'    z.writestr("notes.txt", b"bukan video")',
		'    z.writestr("__MACOSX/._clip-a.mp4", b"junk")',
		'    z.writestr("docs/", b"")',
	].join("\n");
	const proc = Bun.spawnSync(["python3", "-", zipPath], { stdin: new TextEncoder().encode(script) });
	if (proc.exitCode !== 0) throw new Error("fixture zip failed");
});

afterAll(async () => {
	if (createdMediaIds.length > 0) {
		await db.delete(klipMedia).where(inArray(klipMedia.id, createdMediaIds)).catch(() => {});
	}
	if (process.env.KLIP_DATA_ROOT) {
		await rm(process.env.KLIP_DATA_ROOT, { recursive: true, force: true });
		delete process.env.KLIP_DATA_ROOT;
	}
	if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

describe("sanitizeZipEntryName", () => {
	test("keeps basename of nested paths", () => {
		expect(sanitizeZipEntryName({ fileName: "nested/clip-c.mov" })).toBe("clip-c.mov");
	});
	test("rejects traversal, hidden, and macosx", () => {
		expect(sanitizeZipEntryName({ fileName: "../../evil.mp4" })).toBeNull();
		expect(sanitizeZipEntryName({ fileName: "__MACOSX/._clip-a.mp4" })).toBeNull();
		expect(sanitizeZipEntryName({ fileName: ".DS_Store" })).toBeNull();
	});
});

describe("POST /api/uploads/batch", () => {
	test("extracts videos, skips non-video and unsafe entries", async () => {
		const buf = await Bun.file(zipPath).arrayBuffer();
		const res = await uploadBatch(
			req({
				url: "http://localhost/api/uploads/batch",
				init: {
					method: "POST",
					body: (() => {
						const form = new FormData();
						form.append("file", new File([buf], "batch.zip", { type: "application/zip" }));
						return form;
					})(),
				},
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			batchId: string;
			total: number;
			succeeded: number;
			items: Array<{ name: string; status: string; mediaId: string | null; url: string | null; error: string | null }>;
		};
		expect(body.batchId.startsWith("b_")).toBe(true);
		expect(body.succeeded).toBe(3);
		const ok = body.items.filter((i) => i.status === "ok");
		expect(ok.map((i) => i.name).sort()).toEqual(["clip-a.mp4", "clip-b.mp4", "clip-c.mov"]);
		for (const item of ok) {
			expect(item.mediaId).toBeTruthy();
			expect(item.url).toBe(`/api/media/${item.mediaId}`);
			createdMediaIds.push(item.mediaId!);
		}
		const byName = new Map(body.items.map((i) => [i.name, i]));
		expect(byName.get("notes.txt")?.status).toBe("skipped");
		const rows = await db.select().from(klipMedia).where(inArray(klipMedia.id, createdMediaIds));
		expect(rows).toHaveLength(3);
	});

	test("rejects non-zip", async () => {
		const form = new FormData();
		form.append("file", new File([new Uint8Array([1, 2, 3])], "x.mp4", { type: "video/mp4" }));
		const res = await uploadBatch(req({ url: "http://localhost/api/uploads/batch", init: { method: "POST", body: form } }));
		expect(res.status).toBe(400);
	});

	test("rejects zip with traversal entries", async () => {
		const script = [
			"import sys, zipfile",
			"zp = sys.argv[1]",
			'with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:',
			'    z.writestr("../../evil.mp4", b"evil")',
		].join("\n");
		const evilPath = path.join(fixtureDir, "evil.zip");
		const proc = Bun.spawnSync(["python3", "-", evilPath], { stdin: new TextEncoder().encode(script) });
		if (proc.exitCode !== 0) throw new Error("evil fixture failed");
		const buf = await Bun.file(evilPath).arrayBuffer();
		const form = new FormData();
		form.append("file", new File([buf], "evil.zip", { type: "application/zip" }));
		const res = await uploadBatch(req({ url: "http://localhost/api/uploads/batch", init: { method: "POST", body: form } }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/unsafe/i);
	});

	test("rejects corrupt zip", async () => {
		const form = new FormData();
		form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "x.zip", { type: "application/zip" }));
		const res = await uploadBatch(req({ url: "http://localhost/api/uploads/batch", init: { method: "POST", body: form } }));
		expect(res.status).toBe(400);
	});
});
