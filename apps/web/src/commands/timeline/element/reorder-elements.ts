import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import { updateTrackInSceneTracks } from "@/timeline/track-element-update";
import { EditorCore } from "@/core";

/**
 * Swap the order of two elements on the same track (z-order).
 * Follows the DeleteElementsCommand pattern: snapshot + updateTracks + undo.
 */
export class ReorderElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly firstElementId: string;
	private readonly secondElementId: string;

	constructor({
		trackId,
		firstElementId,
		secondElementId,
	}: {
		trackId: string;
		firstElementId: string;
		secondElementId: string;
	}) {
		super();
		this.trackId = trackId;
		this.firstElementId = firstElementId;
		this.secondElementId = secondElementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const swapElements = <TTrack extends TimelineTrack>(track: TTrack): TTrack => {
			const first = track.elements.findIndex((e) => e.id === this.firstElementId);
			const second = track.elements.findIndex((e) => e.id === this.secondElementId);
			if (first === -1 || second === -1) return track;
			const elements = [...track.elements] as TTrack["elements"];
			const tmp = elements[first]!;
			elements[first] = elements[second]!;
			elements[second] = tmp;
			return { ...track, elements };
		};

		const updatedTracks = updateTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			update: swapElements,
		});

		const target =
			updatedTracks.overlay.find((t) => t.id === this.trackId) ??
			(updatedTracks.main.id === this.trackId ? updatedTracks.main : null) ??
			updatedTracks.audio.find((t) => t.id === this.trackId);
		const targetIds = new Set((target?.elements ?? []).map((e) => e.id));
		if (
			!target ||
			!targetIds.has(this.firstElementId) ||
			!targetIds.has(this.secondElementId)
		) {
			return;
		}

		editor.timeline.updateTracks(updatedTracks);
		return {
			selection: {
				selectedElements: [
					{ trackId: this.trackId, elementId: this.firstElementId },
				],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
