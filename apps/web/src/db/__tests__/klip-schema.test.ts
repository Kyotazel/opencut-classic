import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	db,
	klipBrandLayers,
	klipMedia,
	klipProjects,
	type KlipBrandLayer,
	type KlipMedia,
	type KlipProject,
} from "@/db";

const MEDIA_ID = "m_task2_test";
const PROJECT_ID = "p_task2_test";
const LAYER_ID = "l_task2_test";

async function cleanup() {
	await db.delete(klipBrandLayers).where(eq(klipBrandLayers.id, LAYER_ID));
	await db.delete(klipProjects).where(eq(klipProjects.id, PROJECT_ID));
	await db.delete(klipMedia).where(eq(klipMedia.id, MEDIA_ID));
}

describe("klip schema", () => {
	test("insert project + layer + cascade delete", async () => {
		await cleanup();

		await db.insert(klipMedia).values({
			id: MEDIA_ID,
			kind: "source",
			name: "clip.mp4",
			filePath: "uploads/clip.mp4",
			duration: 55.8,
			width: 2560,
			height: 1072,
		});
		const media: KlipMedia[] = await db
			.select()
			.from(klipMedia)
			.where(eq(klipMedia.id, MEDIA_ID));
		expect(media).toHaveLength(1);
		expect(media[0]?.name).toBe("clip.mp4");

		await db.insert(klipProjects).values({
			id: PROJECT_ID,
			name: "Test project",
			sourceMediaId: MEDIA_ID,
		});
		const projects: KlipProject[] = await db
			.select()
			.from(klipProjects)
			.where(eq(klipProjects.id, PROJECT_ID));
		expect(projects).toHaveLength(1);
		expect(projects[0]?.status).toBe("ready");

		await db.insert(klipBrandLayers).values({
			id: LAYER_ID,
			projectId: PROJECT_ID,
			filePath: "uploads/brand.png",
			name: "Brand",
			kind: "image",
		});
		const layers: KlipBrandLayer[] = await db
			.select()
			.from(klipBrandLayers)
			.where(eq(klipBrandLayers.projectId, PROJECT_ID));
		expect(layers).toHaveLength(1);
		expect(layers[0]?.z).toBe(0);

		await db.delete(klipProjects).where(eq(klipProjects.id, PROJECT_ID));
		const orphaned = await db
			.select()
			.from(klipBrandLayers)
			.where(eq(klipBrandLayers.projectId, PROJECT_ID));
		expect(orphaned).toHaveLength(0);

		await cleanup();
	});
});
