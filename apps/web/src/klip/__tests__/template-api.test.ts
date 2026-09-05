import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import {
	db,
	klipBrandLayers,
	klipBrandTemplateLayers,
	klipBrandTemplates,
	klipProjects,
} from "@/db";
import { POST as createLayer } from "@/app/api/klip/projects/[id]/brand/route";
import { GET as byOpencut } from "@/app/api/klip/projects/by-opencut/route";
import { POST as applyTemplate } from "@/app/api/klip/projects/[id]/apply-template/route";
import { POST as saveAsTemplate } from "@/app/api/klip/projects/[id]/save-as-template/route";
import { newBrandId } from "@/klip/brand";
import {
	GET as listTemplates,
	POST as createTemplate,
} from "@/app/api/klip/brand-templates/route";
import {
	DELETE as deleteTemplate,
	GET as getTemplate,
} from "@/app/api/klip/brand-templates/[id]/route";

const createdTemplateIds: string[] = [];
const createdProjectIds: string[] = [];

/** Route handlers take NextRequest; bun tests build plain Requests. */
function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	return new Request(url, init) as unknown as NextRequest;
}

function track({ id }: { id: string }) {
	createdTemplateIds.push(id);
}

async function cleanup() {
	for (const id of createdProjectIds.splice(0)) {
		await db.delete(klipBrandLayers).where(eq(klipBrandLayers.projectId, id)).catch(() => {});
		await db.delete(klipProjects).where(eq(klipProjects.id, id)).catch(() => {});
	}
	for (const id of createdTemplateIds.splice(0)) {
		await db
			.delete(klipBrandTemplateLayers)
			.where(eq(klipBrandTemplateLayers.templateId, id))
			.catch(() => {});
		await db.delete(klipBrandTemplates).where(eq(klipBrandTemplates.id, id)).catch(() => {});
	}
}

beforeAll(async () => {
	process.env.KLIP_DATA_ROOT = await mkdtemp(path.join(tmpdir(), "klip-tpl-"));
});

afterAll(async () => {
	await cleanup();
	if (process.env.KLIP_DATA_ROOT) {
		await rm(process.env.KLIP_DATA_ROOT, { recursive: true, force: true });
		delete process.env.KLIP_DATA_ROOT;
	}
});

describe("brand template CRUD", () => {
	test("create then get template", async () => {
		const created = await createTemplate(
			req({
				url: "http://localhost/api/klip/brand-templates",
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Paket Lebaran" }),
				},
			}),
		);
		expect(created.status).toBe(201);
		const { template } = (await created.json()) as { template: { id: string } };
		track({ id: template.id });
		const got = await getTemplate(
			req({ url: `http://localhost/api/klip/brand-templates/${template.id}` }),
			{ params: Promise.resolve({ id: template.id }) },
		);
		expect(got.status).toBe(200);
		const body = (await got.json()) as { layers: unknown[] };
		expect(body.layers).toEqual([]);
	});

	test("create rejects empty name", async () => {
		const res = await createTemplate(
			req({
				url: "http://localhost/api/klip/brand-templates",
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "  " }),
				},
			}),
		);
		expect(res.status).toBe(400);
	});

	test("list includes created template with layerCount", async () => {
		const res = await listTemplates();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			templates: Array<{ id: string; layerCount: number }>;
		};
		expect(body.templates.length).toBeGreaterThanOrEqual(1);
		for (const t of body.templates) expect(typeof t.layerCount).toBe("number");
	});

	test("delete removes template", async () => {
		const created = await createTemplate(
			req({
				url: "http://localhost/api/klip/brand-templates",
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Hapus Saya" }),
				},
			}),
		);
		const { template } = (await created.json()) as { template: { id: string } };
		const del = await deleteTemplate(
			req({ url: `http://localhost/api/klip/brand-templates/${template.id}` }),
			{ params: Promise.resolve({ id: template.id }) },
		);
		expect(del.status).toBe(200);
		const got = await getTemplate(
			req({ url: `http://localhost/api/klip/brand-templates/${template.id}` }),
			{ params: Promise.resolve({ id: template.id }) },
		);
		expect(got.status).toBe(404);
	});
});

function testJson({ res }: { res: Response }): Promise<Record<string, unknown>> {
	return res.json().then((value: unknown) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("test: response bukan JSON object");
		}
		return Object.fromEntries(Object.entries(value));
	});
}

function testChild({
	rec,
	name,
}: {
	rec: Record<string, unknown>;
	name: string;
}): Record<string, unknown> {
	const v = rec[name];
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new Error(`test: ${name} bukan object`);
	}
	return Object.fromEntries(Object.entries(v));
}

function testStr({ rec, name }: { rec: Record<string, unknown>; name: string }): string {
	const v = rec[name];
	if (typeof v !== "string") throw new Error(`test: ${name} bukan string`);
	return v;
}

function testNum({ rec, name }: { rec: Record<string, unknown>; name: string }): number {
	const v = rec[name];
	if (typeof v !== "number") throw new Error(`test: ${name} bukan number`);
	return v;
}

function testArr({ rec, name }: { rec: Record<string, unknown>; name: string }): unknown[] {
	const v = rec[name];
	if (!Array.isArray(v)) throw new Error(`test: ${name} bukan array`);
	return v;
}

describe("brand template save-as and apply", () => {
	test("save-as-template copies layers with anchor conversion", async () => {

		// Project sumber: durasi 50 dtk, layer logo full + layer ads absolut 50.1-70.1.
		const resolved = await byOpencut(
			req({ url: "http://localhost/api/klip/projects/by-opencut?opencutRef=tpl-save-src" }),
		);
		const { project } = (await resolved.json()) as { project: { id: string } };
		createdProjectIds.push(project.id);
		await db
			.update(klipProjects).set({ duration: 50 }).where(eq(klipProjects.id, project.id));

		for (const payload of [
			{ kind: "image", file: "brand/logo.png", name: "Logo", full: true },
			{ kind: "video", file: "brand/ads.mp4", name: "Ads", full: false, start: 50.1, dur: 20 },
		]) {
			const res = await createLayer(
				req({
					url: `http://localhost/api/klip/projects/${project.id}/brand`,
					init: {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					},
				}),
				{ params: Promise.resolve({ id: project.id }) },
			);
			expect(res.status).toBe(201);
		}
		const saved = await saveAsTemplate(
			req({
				url: `http://localhost/api/klip/projects/${project.id}/save-as-template`,
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Paket SaveAs" }),
				},
			}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(saved.status).toBe(201);
		const { template, layerCount } = (await saved.json()) as {
			template: { id: string };
			layerCount: number;
		};
		expect(layerCount).toBe(2);
		track({ id: template.id });

		const got = await getTemplate(
			req({ url: `http://localhost/api/klip/brand-templates/${template.id}` }),
			{ params: Promise.resolve({ id: template.id }) },
		);
		const { layers } = (await got.json()) as {
			layers: Array<{ name: string; full: boolean; anchor: string; start: number }>;
		};
		const logo = layers.find((l) => l.name === "Logo")!;
		const ads = layers.find((l) => l.name === "Ads")!;
		expect(logo.full).toBe(true);
		expect(logo.anchor).toBe("start");
		expect(ads.anchor).toBe("main_end");
		expect(ads.start).toBeCloseTo(0.1, 9);
	});

	test("save-as meng-anchor ekor yang menjulur (kasus Belakang)", async () => {
		// Project sumber: main 30.1 dtk, BGM 26.9-36.43 (ekor menjulur keluar main).
		const resolved = await byOpencut(
			req({ url: "http://localhost/api/klip/projects/by-opencut?opencutRef=tpl-save-tail" }),
		);
		const projectId = testStr({
			rec: testChild({ rec: await testJson({ res: resolved }), name: "project" }),
			name: "id",
		});
		createdProjectIds.push(projectId);
		await db
			.update(klipProjects).set({ duration: 30.1 }).where(eq(klipProjects.id, projectId));

		for (const payload of [
			{ kind: "image", file: "brand/wm.png", name: "WM", full: true },
			{ kind: "audio", file: "brand/bgm.mp3", name: "BGM", full: false, start: 26.9, dur: 9.53 },
		]) {
			const res = await createLayer(
				req({
					url: `http://localhost/api/klip/projects/${projectId}/brand`,
					init: {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					},
				}),
				{ params: Promise.resolve({ id: projectId }) },
			);
			expect(res.status).toBe(201);
		}
		const saved = await saveAsTemplate(
			req({
				url: `http://localhost/api/klip/projects/${projectId}/save-as-template`,
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Paket Ekor" }),
				},
			}),
			{ params: Promise.resolve({ id: projectId }) },
		);
		expect(saved.status).toBe(201);
		const templateId = testStr({
			rec: testChild({ rec: await testJson({ res: saved }), name: "template" }),
			name: "id",
		});
		track({ id: templateId });

		const got = await getTemplate(
			req({ url: `http://localhost/api/klip/brand-templates/${templateId}` }),
			{ params: Promise.resolve({ id: templateId }) },
		);
		const layers = testArr({ rec: await testJson({ res: got }), name: "layers" });
		const bgmRaw = layers.find((l) => {
			if (typeof l !== "object" || l === null || Array.isArray(l)) return false;
			return Object.fromEntries(Object.entries(l))["name"] === "BGM";
		});
		if (typeof bgmRaw !== "object" || bgmRaw === null || Array.isArray(bgmRaw)) {
			throw new Error("test: layer BGM tidak ditemukan");
		}
		const bgm = Object.fromEntries(Object.entries(bgmRaw));
		expect(bgm["anchor"]).toBe("main_end");
		expect(testNum({ rec: bgm, name: "start" })).toBeCloseTo(-3.2, 9);

		// Apply ke main 50 dtk: BGM nempel 3.2 dtk sebelum ujung main.
		const dst = await byOpencut(
			req({ url: "http://localhost/api/klip/projects/by-opencut?opencutRef=tpl-apply-tail" }),
		);
		const dstId = testStr({
			rec: testChild({ rec: await testJson({ res: dst }), name: "project" }),
			name: "id",
		});
		createdProjectIds.push(dstId);
		const applied = await applyTemplate(
			req({
				url: `http://localhost/api/klip/projects/${dstId}/apply-template`,
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ templateId, mainDuration: 50 }),
				},
			}),
			{ params: Promise.resolve({ id: dstId }) },
		);
		expect(applied.status).toBe(200);
		const out = await testJson({ res: applied });
		const outLayers = testArr({ rec: out, name: "layers" });
		const outBgmRaw = outLayers.find((l) => {
			if (typeof l !== "object" || l === null || Array.isArray(l)) return false;
			return Object.fromEntries(Object.entries(l))["name"] === "BGM";
		});
		if (typeof outBgmRaw !== "object" || outBgmRaw === null || Array.isArray(outBgmRaw)) {
			throw new Error("test: layer BGM hasil apply tidak ditemukan");
		}
		const outBgm = Object.fromEntries(Object.entries(outBgmRaw));
		expect(testNum({ rec: outBgm, name: "start" })).toBeCloseTo(46.8, 9);
		expect(testNum({ rec: out, name: "totalDuration" })).toBeCloseTo(56.33, 9);
	});

	test("apply-template resolves and replaces layers", async () => {
		const tpl = await createTemplate(
			req({
				url: "http://localhost/api/klip/brand-templates",
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Paket Apply" }),
				},
			}),
		);
		const { template } = (await tpl.json()) as { template: { id: string } };
		track({ id: template.id });
		await db.insert(klipBrandTemplateLayers).values([
			{
				id: newBrandId({ prefix: "tlyr" }),
				templateId: template.id,
				assetId: null,
				filePath: "brand/logo.png",
				name: "Logo",
				kind: "image",
				enabled: true,
				anchor: "start",
				x: 0.06,
				y: 0.05,
				scale: 0.36,
				rotate: 0,
				opacity: 100,
				full: true,
				start: 0,
				dur: 0,
				volume: 0.35,
				duck: false,
				z: 0,
			},
			{
				id: newBrandId({ prefix: "tlyr" }),
				templateId: template.id,
				assetId: null,
				filePath: "brand/ads.mp4",
				name: "Ads",
				kind: "video",
				enabled: true,
				anchor: "main_end",
				x: 0.5,
				y: 0.5,
				scale: 1,
				rotate: 0,
				opacity: 100,
				full: false,
				start: 0.1,
				dur: 20,
				volume: 0.35,
				duck: false,
				z: 1,
			},
		]);

		const resolved = await byOpencut(
			req({ url: "http://localhost/api/klip/projects/by-opencut?opencutRef=tpl-apply-dst" }),
		);
		const { project } = (await resolved.json()) as { project: { id: string } };
		createdProjectIds.push(project.id);

		const body = { templateId: template.id, mainDuration: 50 };
		const first = await applyTemplate(
			req({
				url: `http://localhost/api/klip/projects/${project.id}/apply-template`,
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(first.status).toBe(200);
		const out = (await first.json()) as {
			layers: Array<{ name: string; start: number; dur: number }>;
			totalDuration: number;
		};
		expect(out.layers).toHaveLength(2);
		expect(out.layers.find((l) => l.name === "Ads")!.start).toBeCloseTo(50.1, 9);
		expect(out.totalDuration).toBeCloseTo(70.1, 9);

		const second = await applyTemplate(
			req({
				url: `http://localhost/api/klip/projects/${project.id}/apply-template`,
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		const out2 = (await second.json()) as { layers: unknown[] };
		expect(out2.layers).toHaveLength(2);
	});

	test("apply-template rejects unknown main duration", async () => {
		const tpl = await createTemplate(
			req({
				url: "http://localhost/api/klip/brand-templates",
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Paket NoDur" }),
				},
			}),
		);
		const { template } = (await tpl.json()) as { template: { id: string } };
		track({ id: template.id });
		const resolved = await byOpencut(
			req({ url: "http://localhost/api/klip/projects/by-opencut?opencutRef=tpl-apply-nodur" }),
		);
		const { project } = (await resolved.json()) as { project: { id: string } };
		createdProjectIds.push(project.id);
		const res = await applyTemplate(
			req({
				url: `http://localhost/api/klip/projects/${project.id}/apply-template`,
				init: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ templateId: template.id }),
				},
			}),
			{ params: Promise.resolve({ id: project.id }) },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("main duration unknown");
	});
});
