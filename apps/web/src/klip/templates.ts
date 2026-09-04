import { asc, eq, sql } from "drizzle-orm";
import { db, klipBrandTemplateLayers, klipBrandTemplates } from "@/db";
import { newBrandId } from "@/klip/brand";

export type TemplateSummary = {
	id: string;
	name: string;
	layerCount: number;
	updatedAt: Date;
};

export async function listTemplates(): Promise<TemplateSummary[]> {
	const templates = await db
		.select()
		.from(klipBrandTemplates)
		.orderBy(asc(klipBrandTemplates.updatedAt));
	return Promise.all(
		templates.map(async (t) => {
			const [{ n }] = await db
				.select({ n: sql<number>`count(*)` })
				.from(klipBrandTemplateLayers)
				.where(eq(klipBrandTemplateLayers.templateId, t.id));
			return { id: t.id, name: t.name, layerCount: Number(n), updatedAt: t.updatedAt };
		}),
	);
}

export async function createTemplate({ name }: { name: string }) {
	const trimmed = name.trim().slice(0, 255);
	if (!trimmed) throw new Error("name is required");
	const id = newBrandId({ prefix: "btpl" });
	await db.insert(klipBrandTemplates).values({ id, name: trimmed });
	const rows = await db
		.select()
		.from(klipBrandTemplates)
		.where(eq(klipBrandTemplates.id, id))
		.limit(1);
	return rows[0]!;
}

export async function getTemplateWithLayers({ id }: { id: string }) {
	const rows = await db
		.select()
		.from(klipBrandTemplates)
		.where(eq(klipBrandTemplates.id, id))
		.limit(1);
	const template = rows[0];
	if (!template) return null;
	const layers = await db
		.select()
		.from(klipBrandTemplateLayers)
		.where(eq(klipBrandTemplateLayers.templateId, id))
		.orderBy(asc(klipBrandTemplateLayers.z));
	return { template, layers };
}

export async function renameTemplate({ id, name }: { id: string; name: string }) {
	const trimmed = name.trim().slice(0, 255);
	if (!trimmed) throw new Error("name is required");
	await db
		.update(klipBrandTemplates)
		.set({ name: trimmed, updatedAt: new Date() })
		.where(eq(klipBrandTemplates.id, id));
	const rows = await db
		.select()
		.from(klipBrandTemplates)
		.where(eq(klipBrandTemplates.id, id))
		.limit(1);
	return rows[0] ?? null;
}

export async function deleteTemplate({ id }: { id: string }) {
	const existing = await db
		.select({ id: klipBrandTemplates.id })
		.from(klipBrandTemplates)
		.where(eq(klipBrandTemplates.id, id))
		.limit(1);
	if (!existing[0]) return false;
	// Layers ikut terhapus via ON DELETE CASCADE.
	await db.delete(klipBrandTemplates).where(eq(klipBrandTemplates.id, id));
	return true;
}
