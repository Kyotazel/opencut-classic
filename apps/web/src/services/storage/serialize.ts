import type { TProject } from "@/project/types";
import type { SceneTracks } from "@/timeline";
import type { SerializedProject, SerializedScene } from "@/services/storage/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";

/**
 * Serialisasi TProject -> bentuk yang disimpan (Date jadi ISO string).
 *
 * Diekstrak dari StorageService.saveProject supaya worker (Node, Tahap 2) dan
 * editor (browser) memakai konversi yang SAMA PERSIS. Kalau salah satu jalur
 * menyusun bentuk sendiri, project hasil worker bisa gagal dibuka di editor —
 * bug yang mahal dilacak karena datanya "kelihatan benar" di database.
 *
 * AudioBuffer dibuang: tidak bisa diserialisasi ke JSON dan selalu dibangun
 * ulang dari file media saat project dimuat.
 */
export function stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return {
		...tracks,
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		})),
	};
}

export function serializeProject({
	project,
}: {
	project: TProject;
}): SerializedProject {
	const duration =
		project.metadata.duration ??
		getProjectDurationFromScenes({ scenes: project.scenes });
	const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: stripAudioBuffers({ tracks: scene.tracks }),
		bookmarks: scene.bookmarks,
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	}));
	return {
		metadata: {
			id: project.metadata.id,
			name: project.metadata.name,
			thumbnail: project.metadata.thumbnail,
			duration,
			createdAt: project.metadata.createdAt.toISOString(),
			updatedAt: project.metadata.updatedAt.toISOString(),
		},
		scenes: serializedScenes,
		currentSceneId: project.currentSceneId,
		settings: project.settings,
		version: project.version,
		timelineViewState: project.timelineViewState,
	};
}
