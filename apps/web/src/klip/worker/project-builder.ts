import { randomUUID } from "node:crypto";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { serializeProject } from "@/services/storage/serialize";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import { mediaTimeFromSeconds } from "@/wasm";
import type { TProject } from "@/project/types";

export type NodeVideoInput = {
	name: string;
	/** Path absolut file video di disk. */
	absPath: string;
	width: number | null;
	height: number | null;
	duration: number | null;
};

function baseName({ filename }: { filename: string }): string {
	const base = filename.split("/").pop() ?? filename;
	return base.replace(/\.[^.]+$/, "") || "Untitled";
}

/**
 * Bangun TProject dari satu video, TANPA browser.
 *
 * Alur dan bentuknya sengaja dibuat sama dengan createProjectFromServerVideo
 * (jalur "Upload zip" di browser) supaya project hasil worker bisa dibuka di
 * editor. Perbedaan yang tak terhindarkan: di browser media disimpan sebagai
 * File di IndexedDB, di sini file-nya sudah ada di disk server dan project
 * disimpan lewat klip_sync_projects.
 *
 * mediaId = id baris klip_sync_media, karena editor memuat berkas lewat
 * /api/sync/media/<id>. Worker mendaftarkan baris itu lebih dulu.
 */
export function buildProjectFromVideo({
	video,
	projectId,
	mediaAssetId,
}: {
	video: NodeVideoInput;
	projectId: string;
	/**
	 * id baris klip_sync_media untuk video ini. Editor memuat berkas lewat
	 * /api/sync/media/<id ini>, jadi elemen harus menunjuk ke sana.
	 */
	mediaAssetId: string;
}): TProject {
	const assetId = mediaAssetId;
	const duration = mediaTimeFromSeconds({ seconds: video.duration ?? 5 });
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	// mediaType "video" selalu menghasilkan VideoElement, tapi tanda tangan
	// buildElementFromMedia mengembalikan union; diperiksa di sini supaya track
	// main (video) menerimanya tanpa cast.
	const built = buildElementFromMedia({
		mediaId: assetId,
		mediaType: "video",
		name: video.name,
		duration,
		startTime: mediaTimeFromSeconds({ seconds: 0 }),
	});
	if (built.type !== "video") {
		throw new Error(`project-builder: expected video element, got ${built.type}`);
	}
	scene.tracks.main.elements.push({ ...built, id: randomUUID() });

	return {
		metadata: {
			id: projectId,
			name: baseName({ filename: video.name }),
			duration: getProjectDurationFromScenes({ scenes: [scene] }),
			thumbnail: undefined,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: DEFAULT_FPS,
			canvasSize: DEFAULT_CANVAS_SIZE,
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: DEFAULT_BACKGROUND_COLOR },
		},
		version: CURRENT_PROJECT_VERSION,
	} as TProject;
}

/** Bentuk tersimpan yang siap dimasukkan ke klip_sync_projects.data. */
export function serializeProjectForServer({ project }: { project: TProject }): string {
	return JSON.stringify(serializeProject({ project }));
}
