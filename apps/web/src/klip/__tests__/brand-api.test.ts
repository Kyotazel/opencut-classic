import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, klipBrandLayers, klipMedia, klipProjects } from "@/db";
import { POST as uploadBrand } from "@/app/api/klip/brand-assets/route";
import { GET as byOpencut } from "@/app/api/klip/projects/by-opencut/route";
import {
	DELETE as deleteBrand,
	GET as getBrand,
	PATCH as patchBrand,
	POST as createLayer,
} from "@/app/api/klip/projects/[id]/brand/route";

const createdProjectIds: string[] = [];
const createdMediaIds: string[] = [];

/** Route handlers take NextRequest; bun tests build plain Requests. */
function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	return new Request(url, init) as unknown as NextRequest;
}

async function cleanup() {
	for (const id of createdProjectIds.splice(0)) {
		await db.delete(klipBrandLayers).where(eq(klipBrandLayers.projectId, id)).catch(() => {});
		await db.delete(klipProjects).where(eq(klipProjects.id, id)).catch(() => {});
	}
	for (const id of createdMediaIds.splice(0)) {
		await db.delete(klipMedia).where(eq(klipMedia.id, id)).catch(() => {});
	}
}

let fixtureDir = "";

beforeAll(async () => {
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-brand-"));
	fixtureDir = await mkdtemp(path.join(tmpdir(), "klip-brand-fixture-"));
});

afterAll(async () => {
	await cleanup();
	if (process.env.KLIP_DATA_ROOT) {
		await rm(process.env.KLIP_DATA_ROOT, { recursive: true, force: true });
		delete process.env.KLIP_DATA_ROOT;
	}
	if (fixtureDir) {
		await rm(fixtureDir, { recursive: true, force: true });
	}
});

async function resolveProject({ opencutRef }: { opencutRef: string }) {
	const res = await byOpencut(
		req({ url: `http://localhost/api/klip/projects/by-opencut?opencutRef=${opencutRef}` }),
	);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		project: { id: string; opencutRef: string | null; sourceMediaId: string | null };
		layers: unknown[];
	};
	createdProjectIds.push(body.project.id);
	return body;
}

describe("brand api", () => {
	test("by-opencut creates project on first call, returns same row after", async () => {
		const ref = `oc_${Date.now()}_a`;
		const first = await resolveProject({ opencutRef: ref });
		expect(first.project.opencutRef).toBe(ref);
		expect(first.project.sourceMediaId).toBeNull();
		expect(first.layers).toHaveLength(0);

		const second = await resolveProject({ opencutRef: ref });
		expect(second.project.id).toBe(first.project.id);

		// missing opencutRef → 400
		const bad = await byOpencut(
			req({ url: "http://localhost/api/klip/projects/by-opencut" }),
		);
		expect(bad.status).toBe(400);
		await cleanup();
	});

	test("PATCH eye toggle persists", async () => {
		const ref = `oc_${Date.now()}_b`;
		const { project } = await resolveProject({ opencutRef: ref });

		const created = await createLayer(
			req({ url: `http://localhost/api/klip/projects/${project.id}/brand`, init: {
				method: "POST",
				body: JSON.stringify({ kind: "image", file: "brand/wm.png", name: "wm" }),
			}}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { layer: { id: string; enabled: boolean } };
		expect(createdBody.layer.enabled).toBe(true);

		const patched = await patchBrand(
			req({ url: `http://localhost/api/klip/projects/${project.id}/brand`, init: {
				method: "PATCH",
				body: JSON.stringify({ id: createdBody.layer.id, enabled: false }),
			}}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(patched.status).toBe(200);
		const patchedBody = (await patched.json()) as { layer: { enabled: boolean } };
		expect(patchedBody.layer.enabled).toBe(false);

		const fetched = await getBrand(req({ url: "http://localhost/x" }), {
			params: Promise.resolve({ id: project.id }),
		});
		expect(fetched.status).toBe(200);
		const fetchedBody = (await fetched.json()) as {
			layers: Array<{ id: string; enabled: boolean }>;
		};
		expect(fetchedBody.layers.find((l) => l.id === createdBody.layer.id)?.enabled).toBe(false);
		await cleanup();
	});

	test("PATCH z-order persists and DELETE removes", async () => {
		const ref = `oc_${Date.now()}_c`;
		const { project } = await resolveProject({ opencutRef: ref });

		const mk = async (name: string) => {
			const res = await createLayer(
				req({ url: `http://localhost/api/klip/projects/${project.id}/brand`, init: {
					method: "POST",
					body: JSON.stringify({ kind: "image", file: `brand/${name}.png`, name }),
				}}),
				{ params: Promise.resolve({ id: project.id }) },
			);
			expect(res.status).toBe(201);
			return (await res.json()) as { layer: { id: string; z: number } };
		};
		const a = await mk("a");
		const b = await mk("b");
		expect(b.layer.z).toBeGreaterThan(a.layer.z);

		// swap z
		const swapA = await patchBrand(
			req({ url: `http://localhost/api/klip/projects/${project.id}/brand`, init: {
				method: "PATCH",
				body: JSON.stringify({ id: a.layer.id, z: b.layer.z }),
			}}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(swapA.status).toBe(200);
		const swapB = await patchBrand(
			req({ url: `http://localhost/api/klip/projects/${project.id}/brand`, init: {
				method: "PATCH",
				body: JSON.stringify({ id: b.layer.id, z: a.layer.z }),
			}}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(swapB.status).toBe(200);

		const fetched = (await (
			await getBrand(req({ url: "http://localhost/x" }), {
				params: Promise.resolve({ id: project.id }),
			})
		).json()) as { layers: Array<{ id: string; z: number }> };
		expect(fetched.layers.find((l) => l.id === a.layer.id)?.z).toBe(b.layer.z);

		const deleted = await deleteBrand(
			req({
				url: `http://localhost/api/klip/projects/${project.id}/brand?layerId=${a.layer.id}`,
				init: { method: "DELETE" },
			}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(deleted.status).toBe(200);
		const after = (await (
			await getBrand(req({ url: "http://localhost/x" }), {
				params: Promise.resolve({ id: project.id }),
			})
		).json()) as { layers: Array<{ id: string }> };
		expect(after.layers.some((l) => l.id === a.layer.id)).toBe(false);

		// unknown project → 404
		const missing = await getBrand(req({ url: "http://localhost/x" }), {
			params: Promise.resolve({ id: "kproj_missing" }),
		});
		expect(missing.status).toBe(404);
		await cleanup();
	});

	test("brand-assets upload classifies png and rejects txt", async () => {
		const pngBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		const form = new FormData();
		form.append("file", new File([pngBytes], "logo.png", { type: "image/png" }));
		const res = await uploadBrand(
			req({ url: "http://localhost/api/klip/brand-assets", init: {
				method: "POST",
				body: form,
			}}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			mediaId: string;
			url: string;
			kind: string;
		};
		expect(body.kind).toBe("image");
		expect(body.url).toBe(`/api/media/${body.mediaId}`);
		createdMediaIds.push(body.mediaId);

		const rows = await db.select().from(klipMedia).where(eq(klipMedia.id, body.mediaId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("brand");
		expect(rows[0]?.assetKind).toBe("image");
		expect(rows[0]?.filePath.startsWith("brand/")).toBe(true);

		const badForm = new FormData();
		badForm.append("file", new File(["x"], "note.txt", { type: "text/plain" }));
		const bad = await uploadBrand(
			req({ url: "http://localhost/api/klip/brand-assets", init: {
				method: "POST",
				body: badForm,
			}}),
		);
		expect(bad.status).toBe(400);
		await cleanup();
	});
});
