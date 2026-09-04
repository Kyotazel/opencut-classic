import { asc, eq, sql } from "drizzle-orm";
import { db, klipBrandLayers, klipBrandTemplateLayers, klipBrandTemplates, klipMedia, klipProjects } from "@/db";
import { listLayers, newBrandId, rowToLayer } from "@/klip/brand";
import {
	resolveTemplateLayer,
	resolveTotalDuration,
	type TemplateAnchor,
} from "@/klip/template-resolve";

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
export async function resolveMainDuration({
	project,
	override,
}: {
	project: { duration: number | null; sourceMediaId: string | null };
	override?: number | null;
}): Promise<number | null> {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) {
		return override;
	}
	if (typeof project.duration === "number" && project.duration > 0) {
		return project.duration;
	}
	if (project.sourceMediaId) {
		const rows = await db
			.select({ duration: klipMedia.duration })
			.from(klipMedia)
			.where(eq(klipMedia.id, project.sourceMediaId))
			.limit(1);
		const d = rows[0]?.duration;
		if (typeof d === "number" && d > 0) return d;
	}
	return null;
}

function toTemplateAnchor({
	full,
	start,
	mainDuration,
}: {
	full: boolean;
	start: number;
	mainDuration: number | null;
}): { anchor: TemplateAnchor; start: number } {
	if (full || mainDuration == null || start < mainDuration) {
		return { anchor: "start", start };
	}
	return { anchor: "main_end", start: start - mainDuration };
}

export async function saveAsTemplate({
	projectId,
	name,
}: {
	projectId: string;
	name: string;
}) {
	const trimmed = name.trim().slice(0, 255);
	if (!trimmed) throw new Error("name is required");
	const projects = await db
		.select()
		.from(klipProjects)
		.where(eq(klipProjects.id, projectId))
		.limit(1);
	const project = projects[0];
	if (!project) return null;
	const template = await createTemplate({ name: trimmed });
	const layers = await listLayers({ projectId });
	const mainDuration = await resolveMainDuration({ project });
	let n = 0;
	for (const l of layers) {
		const { anchor, start } = toTemplateAnchor({
			full: l.full,
			start: l.start,
			mainDuration,
		});
		await db.insert(klipBrandTemplateLayers).values({
			id: newBrandId({ prefix: "tlyr" }),
			templateId: template.id,
			assetId: l.asset_id,
			filePath: l.file,
			name: l.name,
			kind: l.kind,
			enabled: l.enabled,
			anchor,
			x: l.x,
			y: l.y,
			scale: l.scale,
			rotate: l.rotate,
			opacity: l.opacity,
			full: l.full,
			start,
			dur: l.dur,
			volume: l.volume,
			duck: l.duck,
			z: l.z,
		});
		n += 1;
	}
	return { template, layerCount: n };
}

export async function applyTemplate({
	projectId,
	templateId,
	mainDuration: override,
}: {
	projectId: string;
	templateId: string;
	mainDuration?: number | null;
}) {
	const projects = await db
		.select()
		.from(klipProjects)
		.where(eq(klipProjects.id, projectId))
		.limit(1);
	const project = projects[0];
	if (!project) return { status: 404 as const, error: "Project not found" };
	const found = await getTemplateWithLayers({ id: templateId });
	if (!found) return { status: 404 as const, error: "Template not found" };
	const mainDuration = await resolveMainDuration({ project, override });
	if (mainDuration == null) {
		return { status: 400 as const, error: "main duration unknown" };
	}
	// Replace, bukan append: apply template menentukan state brand project.
	await db.delete(klipBrandLayers).where(eq(klipBrandLayers.projectId, projectId));
	const resolved = found.layers.map((l) => ({
		layer: l,
		r: resolveTemplateLayer(
			{ anchor: l.anchor as TemplateAnchor, full: l.full, start: l.start, dur: l.dur },
			mainDuration,
		),
	}));
	for (const { layer, r } of resolved) {
		await db.insert(klipBrandLayers).values({
			id: newBrandId({ prefix: "lyr" }),
			projectId,
			assetId: layer.assetId,
			filePath: layer.filePath,
			name: layer.name,
			kind: layer.kind,
			enabled: layer.enabled,
			x: layer.x,
			y: layer.y,
			scale: layer.scale,
			rotate: layer.rotate,
			opacity: layer.opacity,
			full: layer.full,
			start: r.start,
			dur: r.dur,
			volume: layer.volume,
			duck: layer.duck,
			z: layer.z,
		});
	}
	const rows = await db
		.select()
		.from(klipBrandLayers)
		.where(eq(klipBrandLayers.projectId, projectId));
	const layers = rows.map((row) => rowToLayer({ row }));
	const totalDuration = resolveTotalDuration(
		mainDuration,
		layers.map((l) => ({ start: l.start, dur: l.dur })),
	);
	return { status: 200 as const, layers, totalDuration };
}
