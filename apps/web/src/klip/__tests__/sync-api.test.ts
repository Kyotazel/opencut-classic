import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, klipSyncMedia, klipSyncProjects } from "@/db";
import { generateUUID } from "@/utils/id";
import { GET as listProjects } from "@/app/api/sync/projects/route";
import { GET as getProject, PUT as putProject } from "@/app/api/sync/projects/[id]/route";
import {
	GET as listMedia,
	POST as uploadMedia,
} from "@/app/api/sync/projects/[id]/media/route";
import { GET as downloadMedia } from "@/app/api/sync/media/[assetId]/route";

const createdIds: string[] = [];

function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	const r: unknown = new Request(url, init);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return r as NextRequest;
}

function ctx({ id }: { id: string }): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}

function asRecord({ value }: { value: unknown }): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}

async function cleanup() {
	for (const id of createdIds.splice(0)) {
		await db.delete(klipSyncMedia).where(eq(klipSyncMedia.projectId, id)).catch(() => {});
		await db.delete(klipSyncProjects).where(eq(klipSyncProjects.id, id)).catch(() => {});
	}
}

afterAll(cleanup);

function newId(): string {
	const id = `st_${generateUUID().replace(/-/g, "").slice(0, 12)}`;
	createdIds.push(id);
	return id;
}

describe("sync api", () => {
	test("PUT baru lalu GET penuh, list tanpa blob", async () => {
		const id = newId();
		const put = await putProject(
			req({
				url: "http://t/x",
				init: {
					method: "PUT",
					body: JSON.stringify({ name: "P1", data: JSON.stringify({ hello: 1 }), baseUpdatedAt: null }),
				},
			}),
			ctx({ id }),
		);
		expect(put.status).toBe(200);
		const get = await getProject(req({ url: "http://t/x" }), ctx({ id }));
		expect(get.status).toBe(200);
		const body: unknown = await get.json();
		const rec = asRecord({ value: body });
		expect(rec?.["name"]).toBe("P1");
		expect(rec?.["data"]).toBe(JSON.stringify({ hello: 1 }));
		const list = await listProjects();
		const listBody: unknown = await list.json();
		const listRec = asRecord({ value: listBody });
		const rawList = listRec?.["projects"];
		const found = Array.isArray(rawList)
			? rawList.map((p) => asRecord({ value: p })).find((r) => r?.["id"] === id) ?? null
			: null;
		expect(found).toBeDefined();
		expect(found?.["data"]).toBeUndefined();
	});

	test("PUT base lama -> 409, base baru -> 200", async () => {
		const id = newId();
		await putProject(
			req({
				url: "http://t/x",
				init: { method: "PUT", body: JSON.stringify({ name: "P", data: "{}", baseUpdatedAt: null }) },
			}),
			ctx({ id }),
		);
		const conflict = await putProject(
			req({
				url: "http://t/x",
				init: {
					method: "PUT",
					body: JSON.stringify({ name: "P", data: "{}", baseUpdatedAt: new Date(0).toISOString() }),
				},
			}),
			ctx({ id }),
		);
		expect(conflict.status).toBe(409);
		const fresh = await putProject(
			req({
				url: "http://t/x",
				init: {
					method: "PUT",
					body: JSON.stringify({ name: "P2", data: "{}", baseUpdatedAt: new Date().toISOString() }),
				},
			}),
			ctx({ id }),
		);
		expect(fresh.status).toBe(200);
	});

	test("PUT data bukan JSON -> 400", async () => {
		const res = await putProject(
			req({
				url: "http://t/x",
				init: { method: "PUT", body: JSON.stringify({ name: "P", data: "bukan-json", baseUpdatedAt: null }) },
			}),
			ctx({ id: newId() }),
		);
		expect(res.status).toBe(400);
	});

	test("media: upload lalu download byte-identik; asset jahat ditolak", async () => {
		const id = newId();
		await putProject(
			req({
				url: "http://t/x",
				init: { method: "PUT", body: JSON.stringify({ name: "M", data: "{}", baseUpdatedAt: null }) },
			}),
			ctx({ id }),
		);
		const bytes = new Uint8Array([10, 20, 30, 40]);
		const form = new FormData();
		form.set("assetId", "asset_abc123");
		form.set("file", new File([bytes], "clip.mp4", { type: "video/mp4" }));
		const up = await uploadMedia(req({ url: "http://t/x", init: { method: "POST", body: form } }), ctx({ id }));
		expect(up.status).toBe(201);
		const list = await listMedia(req({ url: "http://t/x" }), ctx({ id }));
		expect(list.status).toBe(200);
		const down = await downloadMedia(req({ url: "http://t/x" }), {
			params: Promise.resolve({ assetId: "asset_abc123" }),
		});
		expect(down.status).toBe(200);
		expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes);
		const evil = new FormData();
		evil.set("assetId", "../jahat");
		evil.set("file", new File([bytes], "x.mp4", { type: "video/mp4" }));
		const evilRes = await uploadMedia(
			req({ url: "http://t/x", init: { method: "POST", body: evil } }),
			ctx({ id }),
		);
		expect(evilRes.status).toBe(400);
	});

	test("media ke project tak ada -> 409; GET project tak ada -> 404", async () => {
		const form = new FormData();
		form.set("assetId", "a1");
		form.set("file", new File([new Uint8Array([1])], "x.mp4", { type: "video/mp4" }));
		const up = await uploadMedia(
			req({ url: "http://t/x", init: { method: "POST", body: form } }),
			ctx({ id: "st_tidak_ada" }),
		);
		expect(up.status).toBe(409);
		const get = await getProject(req({ url: "http://t/x" }), ctx({ id: "st_tidak_ada" }));
		expect(get.status).toBe(404);
	});
});
