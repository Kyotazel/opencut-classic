import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, klipMedia } from "@/db";
import { GET } from "@/app/api/media/[id]/route";
import { POST } from "@/app/api/uploads/route";
import { dataRoot } from "@/klip/upload";

let fixtureDir = "";
let fixtureMp4 = "";

beforeAll(async () => {
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-upload-"));
	fixtureDir = await mkdtemp(path.join(tmpdir(), "klip-fixture-"));
	fixtureMp4 = path.join(fixtureDir, "clip.mp4");
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-y",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=128x96:rate=10",
			"-pix_fmt",
			"yuv420p",
			fixtureMp4,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error("ffmpeg failed to generate test fixture");
	}
});

afterAll(async () => {
	if (process.env.KLIP_DATA_ROOT) {
		await rm(process.env.KLIP_DATA_ROOT, { recursive: true, force: true });
		delete process.env.KLIP_DATA_ROOT;
	}
	if (fixtureDir) {
		await rm(fixtureDir, { recursive: true, force: true });
	}
});

describe("POST /api/uploads", () => {
	test("rejects non-video with 400", async () => {
		const form = new FormData();
		form.append("file", new File(["x"], "note.txt", { type: "text/plain" }));
		const res = await POST(
			new Request("http://localhost/api/uploads", {
				method: "POST",
				body: form,
			}),
		);
		expect(res.status).toBe(400);
	});

	test("rejects missing file with 400", async () => {
		const res = await POST(
			new Request("http://localhost/api/uploads", {
				method: "POST",
				body: new FormData(),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/file is required/);
	});

	test("stores mp4, records DB row, and serves via GET", async () => {
		const bytes = await Bun.file(fixtureMp4).arrayBuffer();
		const form = new FormData();
		form.append(
			"file",
			new File([bytes], "clip.mp4", { type: "video/mp4" }),
		);
		const res = await POST(
			new Request("http://localhost/api/uploads", {
				method: "POST",
				body: form,
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			mediaId: string;
			url: string;
			width: number | null;
			height: number | null;
			duration: number | null;
			thumbnailUrl: string | null;
		};
		expect(body.mediaId).toMatch(/^m_[0-9a-f]{12}$/);
		expect(body.url).toBe(`/api/media/${body.mediaId}`);
		expect(body.width).toBe(128);
		expect(body.height).toBe(96);
		expect(body.duration).toBeGreaterThan(0);
		expect(body.thumbnailUrl).toBeNull();

		const rows = await db
			.select()
			.from(klipMedia)
			.where(eq(klipMedia.id, body.mediaId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.filePath).toBe(`uploads/${body.mediaId}.mp4`);
		expect(rows[0]?.kind).toBe("source");
		expect(rows[0]?.assetKind).toBe("video");
		const onDisk = Bun.file(path.join(dataRoot(), rows[0]?.filePath ?? ""));
		expect(await onDisk.exists()).toBe(true);

		const serve = await GET(
			new Request(`http://localhost/api/media/${body.mediaId}`),
			{ params: Promise.resolve({ id: body.mediaId }) },
		);
		expect(serve.status).toBe(200);
		expect(serve.headers.get("content-type")).toBe("video/mp4");
		expect((await serve.arrayBuffer()).byteLength).toBeGreaterThan(0);

		const missing = await GET(new Request("http://localhost/api/media/m_nope"), {
			params: Promise.resolve({ id: "m_nope" }),
		});
		expect(missing.status).toBe(404);

		await db.delete(klipMedia).where(eq(klipMedia.id, body.mediaId));
	});
});
