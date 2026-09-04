import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, klipBrandTemplateLayers, klipBrandTemplates } from "@/db";
import {
	GET as listTemplates,
	POST as createTemplate,
} from "@/app/api/klip/brand-templates/route";
import {
	DELETE as deleteTemplate,
	GET as getTemplate,
} from "@/app/api/klip/brand-templates/[id]/route";

const createdTemplateIds: string[] = [];

/** Route handlers take NextRequest; bun tests build plain Requests. */
function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	return new Request(url, init) as unknown as NextRequest;
}

function track({ id }: { id: string }) {
	createdTemplateIds.push(id);
}

async function cleanup() {
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
