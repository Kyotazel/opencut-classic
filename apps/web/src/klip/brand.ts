import path from "node:path";
import { eq } from "drizzle-orm";
import { db, klipBrandLayers, klipProjects } from "@/db";
import { generateUUID } from "@/utils/id";
import type { KlipBrandKind } from "./brand-map";

export const BRAND_DIR = "brand";

export const BRAND_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const BRAND_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
export const BRAND_AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);

export type BrandAssetKind = "image" | "video" | "audio";

export function classifyBrandUpload({
	filename,
}: {
	filename: string;
}): BrandAssetKind | null {
	const ext = path.extname(filename).toLowerCase();
	if (BRAND_IMAGE_EXTS.has(ext)) return "image";
	if (BRAND_VIDEO_EXTS.has(ext)) return "video";
	if (BRAND_AUDIO_EXTS.has(ext)) return "audio";
	return null;
}

export function newBrandId({ prefix }: { prefix: string }): string {
	return `${prefix}_${generateUUID().replace(/-/g, "").slice(0, 12)}`;
}

export type BrandLayerRow = typeof klipBrandLayers.$inferSelect;

export function rowToLayer({ row }: { row: BrandLayerRow }) {
	return {
		id: row.id,
		asset_id: row.assetId,
		file: row.filePath,
		name: row.name,
		kind: row.kind as KlipBrandKind,
		enabled: row.enabled,
		x: row.x,
		y: row.y,
		scale: row.scale,
		rotate: row.rotate,
		start: row.start,
		dur: row.dur,
		full: row.full,
		volume: row.volume,
		duck: row.duck,
		opacity: row.opacity,
		z: row.z,
	};
}

/**
 * Minimal Slice 1 project scoping: resolve a klip_projects row by its
 * opencut project ref, creating one (sourceMediaId null) when absent.
 */
export async function resolveOrCreateProject({
	opencutRef,
	name,
}: {
	opencutRef: string;
	name?: string;
}) {
	const existing = await db
		.select()
		.from(klipProjects)
		.where(eq(klipProjects.opencutRef, opencutRef))
		.limit(1);
	if (existing[0]) {
		return existing[0];
	}
	const id = newBrandId({ prefix: "kproj" });
	await db.insert(klipProjects).values({
		id,
		name: (name ?? "Untitled").slice(0, 255),
		batchId: null,
		sourceMediaId: null,
		status: "ready",
		opencutRef,
		duration: null,
		width: null,
		height: null,
		fps: null,
	});
	const rows = await db
		.select()
		.from(klipProjects)
		.where(eq(klipProjects.id, id))
		.limit(1);
	const created = rows[0];
	if (!created) {
		throw new Error("brand: failed to create klip project");
	}
	return created;
}

export async function listLayers({ projectId }: { projectId: string }) {
	const rows = await db
		.select()
		.from(klipBrandLayers)
		.where(eq(klipBrandLayers.projectId, projectId));
	return [...rows]
		.sort((a, b) => a.z - b.z || (a.createdAt.getTime() - b.createdAt.getTime()))
		.map((row) => rowToLayer({ row }));
}
