import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import {
	db,
	klipIgAccounts,
	klipIgPublishItems,
	klipIgPublishes,
	klipProjects,
} from "@/db";
import { generateUUID } from "@/utils/id";
import { encryptToken } from "@/klip/ig-token";
import {
	__setPublishFn,
	aggregatePublishStatus,
	newPublishId,
	parseAccountIds,
	processItems,
	publishVideoPath,
	validateCaption,
	validateVideoFile,
} from "@/klip/ig-publish";
import { POST as createPublish } from "@/app/api/klip/publishes/route";
import { GET as getPublish } from "@/app/api/klip/publishes/[id]/route";
import { PATCH as patchCaption } from "@/app/api/klip/projects/[id]/caption/route";

const createdProjectIds: string[] = [];
const createdAccountIds: string[] = [];
const createdPublishIds: string[] = [];

function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	const r: unknown = new Request(url, init);
	// bun test tidak punya NextRequest asli; pola yang sama dipakai template-api.test.ts
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return r as NextRequest;
}

function mp4({ name, size }: { name: string; size: number }): File {
	return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

async function cleanup() {
	for (const id of createdPublishIds.splice(0)) {
		await db.delete(klipIgPublishItems).where(eq(klipIgPublishItems.publishId, id)).catch(() => {});
		await db.delete(klipIgPublishes).where(eq(klipIgPublishes.id, id)).catch(() => {});
	}
	for (const id of createdAccountIds.splice(0)) {
		await db.delete(klipIgAccounts).where(eq(klipIgAccounts.id, id)).catch(() => {});
	}
	for (const id of createdProjectIds.splice(0)) {
		await db.delete(klipProjects).where(eq(klipProjects.id, id)).catch(() => {});
	}
}

afterAll(cleanup);

async function makeProject(): Promise<string> {
	const id = `p_test_${generateUUID().replace(/-/g, "").slice(0, 8)}`;
	await db.insert(klipProjects).values({ id, name: "test publish" });
	createdProjectIds.push(id);
	return id;
}

async function makeAccount(): Promise<string> {
	process.env.IG_TOKEN_KEY = "cd".repeat(32);
	const id = `ig_test_${generateUUID().replace(/-/g, "").slice(0, 8)}`;
	await db.insert(klipIgAccounts).values({
		id,
		igUserId: `u_${generateUUID().replace(/-/g, "").slice(0, 8)}`,
		username: "akun_test",
		accessTokenEnc: encryptToken("tok-test"),
		status: "active",
	});
	createdAccountIds.push(id);
	return id;
}

describe("ig-publish validasi", () => {
	test("parseAccountIds menolak kosong, >10, dan non-string", () => {
		expect(() => parseAccountIds({ raw: "[]" })).toThrow();
		expect(() => parseAccountIds({ raw: JSON.stringify(new Array(11).fill("a")) })).toThrow();
		expect(() => parseAccountIds({ raw: "bukan-json" })).toThrow();
		expect(parseAccountIds({ raw: JSON.stringify(["a", "b", "a"]) })).toEqual(["a", "b"]);
	});
	test("validateCaption menolak non-string dan >2200 char", () => {
		expect(() => validateCaption({ caption: 123 })).toThrow();
		expect(() => validateCaption({ caption: "x".repeat(2201) })).toThrow();
		expect(validateCaption({ caption: "halo" })).toBe("halo");
	});
	test("validateVideoFile hanya terima .mp4 tak kosong", () => {
		expect(() => validateVideoFile({ file: null })).toThrow();
		expect(() => validateVideoFile({ file: mp4({ name: "a.mov", size: 10 }) })).toThrow();
		expect(() => validateVideoFile({ file: mp4({ name: "a.mp4", size: 0 }) })).toThrow();
		expect(validateVideoFile({ file: mp4({ name: "A.MP4", size: 10 }) }).name).toBe("A.MP4");
	});
	test("aggregatePublishStatus", () => {
		expect(aggregatePublishStatus({ items: [] })).toBe("failed");
		expect(aggregatePublishStatus({ items: [{ status: "published" }] })).toBe("done");
		expect(
			aggregatePublishStatus({ items: [{ status: "published" }, { status: "failed" }] }),
		).toBe("partial");
		expect(aggregatePublishStatus({ items: [{ status: "failed" }] })).toBe("failed");
		expect(aggregatePublishStatus({ items: [{ status: "queued" }] })).toBe("processing");
	});
});

describe("publishes route", () => {
	beforeEach(() => {
		process.env.IG_TOKEN_KEY = "cd".repeat(32);
	});

	test("POST tanpa file ditolak 400 dan tidak buat job", async () => {
		const projectId = await makeProject();
		const accountId = await makeAccount();
		const form = new FormData();
		form.set("projectId", projectId);
		form.set("caption", "x");
		form.set("accountIds", JSON.stringify([accountId]));
		const res = await createPublish(req({ url: "http://t/api/klip/publishes", init: { method: "POST", body: form } }));
		expect(res.status).toBe(400);
	});

	test("POST akun tidak aktif ditolak 409", async () => {
		const projectId = await makeProject();
		const accountId = await makeAccount();
		await db.update(klipIgAccounts).set({ status: "disconnected" }).where(eq(klipIgAccounts.id, accountId));
		const form = new FormData();
		form.set("projectId", projectId);
		form.set("caption", "x");
		form.set("accountIds", JSON.stringify([accountId]));
		form.set("file", mp4({ name: "v.mp4", size: 100 }));
		const res = await createPublish(req({ url: "http://t/api/klip/publishes", init: { method: "POST", body: form } }));
		expect(res.status).toBe(409);
	});

	test("GET publish tak dikenal 404", async () => {
		const res = await getPublish(req({ url: "http://t/x" }), { params: Promise.resolve({ id: "p_tidak_ada" }) });
		expect(res.status).toBe(404);
	});

	test("PATCH caption tersimpan", async () => {
		const projectId = await makeProject();
		const res = await patchCaption(
			req({
				url: "http://t/x",
				init: { method: "PATCH", body: JSON.stringify({ caption: "caption baru" }) },
			}),
			{ params: Promise.resolve({ id: projectId }) },
		);
		expect(res.status).toBe(200);
		const [row] = await db.select().from(klipProjects).where(eq(klipProjects.id, projectId)).limit(1);
		expect(row?.caption).toBe("caption baru");
	});

	test("processItems sukses menandai published + permalink", async () => {
		const projectId = await makeProject();
		const accountId = await makeAccount();
		const publishId = newPublishId({ prefix: "p" });
		createdPublishIds.push(publishId);
		const { abs, rel } = publishVideoPath({ publishId });
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, new Uint8Array([1, 2, 3]));
		await db.insert(klipIgPublishes).values({ id: publishId, projectId, caption: "c", videoPath: rel });
		const itemId = newPublishId({ prefix: "pi" });
		await db.insert(klipIgPublishItems).values({ id: itemId, publishId, igAccountId: accountId });
		__setPublishFn({
			fn: (async () => ({ containerId: "c1", permalink: "https://ig.example/p/1" })) as typeof import("@/klip/ig-api").publishReel,
		});
		await processItems({ publishId });
		const [item] = await db.select().from(klipIgPublishItems).where(eq(klipIgPublishItems.id, itemId)).limit(1);
		expect(item?.status).toBe("published");
		expect(item?.permalink).toBe("https://ig.example/p/1");
		const [pub] = await db.select().from(klipIgPublishes).where(eq(klipIgPublishes.id, publishId)).limit(1);
		expect(pub?.status).toBe("done");
		await rm(abs, { force: true });
	});

	test("processItems token invalid menandai akun expired", async () => {
		const projectId = await makeProject();
		const accountId = await makeAccount();
		const publishId = newPublishId({ prefix: "p" });
		createdPublishIds.push(publishId);
		const { abs, rel } = publishVideoPath({ publishId });
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, new Uint8Array([9]));
		await db.insert(klipIgPublishes).values({ id: publishId, projectId, caption: "", videoPath: rel });
		const itemId = newPublishId({ prefix: "pi" });
		await db.insert(klipIgPublishItems).values({ id: itemId, publishId, igAccountId: accountId });
		__setPublishFn({
			fn: (async () => {
				throw new Error("IG_TOKEN_INVALID: basi");
			}) as typeof import("@/klip/ig-api").publishReel,
		});
		await processItems({ publishId });
		const [item] = await db.select().from(klipIgPublishItems).where(eq(klipIgPublishItems.id, itemId)).limit(1);
		expect(item?.status).toBe("failed");
		const [acc] = await db.select().from(klipIgAccounts).where(eq(klipIgAccounts.id, accountId)).limit(1);
		expect(acc?.status).toBe("token_expired");
		await rm(abs, { force: true });
	});
});
