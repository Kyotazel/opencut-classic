import { toast } from "sonner";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds } from "@/wasm";

export type BatchProjectItem = {
	name: string;
	url: string;
	width: number | null;
	height: number | null;
	duration: number | null;
};

function baseName({ filename }: { filename: string }): string {
	const base = filename.split("/").pop() ?? filename;
	return base.replace(/\.[^.]+$/, "") || "Untitled";
}

/**
 * Membuat satu project opencut headless (tanpa aktivasi editor) berisi video
 * di track utama. Cermin createNewProject di ProjectManager, ditambah elemen.
 */
export async function createProjectFromServerVideo({
	item,
	fetchFile,
}: {
	item: BatchProjectItem;
	fetchFile: (url: string) => Promise<File>;
}): Promise<string> {
	const file = await fetchFile(item.url);
	const [processed] = await processMediaAssets({
		files: [file],
		serverMeta: {
			url: item.url,
			width: item.width,
			height: item.height,
			duration: item.duration,
			thumbnailUrl: null,
		},
	});
	if (!processed) throw new Error(`Tidak bisa memproses ${item.name}`);

	const assetId = generateUUID();
	const duration =
		processed.duration != null
			? mediaTimeFromSeconds({ seconds: processed.duration })
			: DEFAULT_NEW_ELEMENT_DURATION;
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	const element = {
		...buildElementFromMedia({
			mediaId: assetId,
			mediaType: processed.type,
			name: processed.name,
			duration,
			startTime: mediaTimeFromSeconds({ seconds: 0 }),
		}),
		id: generateUUID(),
	};

	// Track main hanya menerima video/image. Audio harus punya track sendiri,
	// kalau tidak ia jadi elemen yang tidak dikenali track-nya. Varian lain
	// (text/sticker/graphic/effect) tidak mungkin dihasilkan buildElementFromMedia.
	if (element.type === "audio") {
		scene.tracks.audio.push({
			...buildEmptyTrack({ id: generateUUID(), type: "audio" }),
			elements: [element],
		});
	} else if (element.type === "video" || element.type === "image") {
		scene.tracks.main.elements.push(element);
	}

	const projectId = generateUUID();
	const project: TProject = {
		metadata: {
			id: projectId,
			name: baseName({ filename: processed.name }),
			duration: getProjectDurationFromScenes({ scenes: [scene] }),
			// Thumbnail langsung dari frame video agar kartu project tidak
			// blank sebelum dibuka (editor normal mengisi ini saat dibuka).
			thumbnail: processed.thumbnailUrl ?? undefined,
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
	};
	const mediaAsset: MediaAsset = { ...processed, id: assetId };
	await storageService.saveProject({ project });
	try {
		await storageService.saveMediaAsset({ projectId, mediaAsset });
	} catch (error) {
		console.error("Batch: saveMediaAsset failed", error);
		toast.warning(`Project ${project.metadata.name} dibuat tanpa cache media lokal`);
	}
	return projectId;
}
