"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useEditor } from "@/editor/use-editor";
import {
	type KlipBrandKind,
	type KlipBrandLayer,
	fileExtension,
	klipLayerToElement,
	VOLUME_DB_MAX,
	VOLUME_DB_MIN,
} from "@/klip/brand-map";
import type { TimelineElement } from "@/timeline/types";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete02Icon,
	Layers01Icon,
	ViewIcon,
	ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";

type Draft = KlipBrandLayer & { elementId: string | null; trackId: string | null };

const GAIN_DEFAULT = 0.35;

function gainToDb({ gain }: { gain: number }): number {
	const clamped = Math.max(gain, 10 ** (VOLUME_DB_MIN / 20));
	return Math.min(Math.max(20 * Math.log10(clamped), VOLUME_DB_MIN), VOLUME_DB_MAX);
}

function dbToGain({ db }: { db: number }): number {
	return 10 ** (db / 20);
}

function toDbLabel({ db }: { db: number }): string {
	return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export function BrandPanel() {
	const editor = useEditor();
	const project = useEditor((e) => {
		try {
			return e.project.getActive();
		} catch {
			return null;
		}
	});
	const [klipProjectId, setKlipProjectId] = useState<string | null>(null);
	const [layers, setLayers] = useState<Draft[]>([]);
	const [loading, setLoading] = useState(true);
	const [uploading, setUploading] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const opencutRef = project?.metadata.id ?? null;
	const projectName = project?.metadata.name ?? "Untitled";
	const canvasWidth = project?.settings.canvasSize.width ?? 1080;
	const canvasHeight = project?.settings.canvasSize.height ?? 1920;
	const totalDuration = useMemo(() => {
		if (!project) return 10;
		try {
			const seconds = mediaTimeToSeconds({ time: project.metadata.duration });
			return seconds > 0 ? seconds : 10;
		} catch {
			return 10;
		}
	}, [project]);

	const refresh = useCallback(async () => {
		if (!opencutRef) {
			setLoading(false);
			return;
		}
		try {
			const res = await fetch(
				`/api/klip/projects/by-opencut?opencutRef=${encodeURIComponent(opencutRef)}&name=${encodeURIComponent(projectName)}`,
			);
			if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
			const body = (await res.json()) as {
				project: { id: string };
				layers: KlipBrandLayer[];
			};
			setKlipProjectId(body.project.id);
			setLayers((prev) => {
				const prevById = new Map(prev.map((l) => [l.id, l]));
				return body.layers.map((l) => ({
					...l,
					elementId: prevById.get(l.id)?.elementId ?? null,
					trackId: prevById.get(l.id)?.trackId ?? null,
				}));
			});
		} catch (error) {
			console.error("Brand panel: failed to load layers", error);
			toast.error("Failed to load brand layers");
		} finally {
			setLoading(false);
		}
	}, [opencutRef, projectName]);

	useEffect(() => {
		setLoading(true);
		void refresh();
	}, [refresh]);

	const patchLayer = useCallback(
		async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
			if (!klipProjectId) return null;
			const res = await fetch(`/api/klip/projects/${klipProjectId}/brand`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id, ...patch }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `PATCH failed: ${res.status}`);
			}
			const body = (await res.json()) as { layer: KlipBrandLayer };
			setLayers((prev) =>
				prev.map((l) =>
					l.id === id ? { ...body.layer, elementId: l.elementId, trackId: l.trackId } : l,
				),
			);
			return body.layer;
		},
		[klipProjectId],
	);

	const applyTransformToElement = useCallback(
		({ draft, patch }: { draft: Draft; patch: Partial<KlipBrandLayer> }) => {
			if (!draft.elementId || !draft.trackId) return;
			const next = { ...draft, ...patch };
			const posX = (next.x - 0.5) * canvasWidth;
			const posY = (0.5 - next.y) * canvasHeight;
			const scale = Math.max(next.scale, 0.01);
			const elementPatch: Partial<TimelineElement> = {
				hidden: !next.enabled,
				params: {
					"transform.positionX": posX,
					"transform.positionY": posY,
					"transform.scaleX": scale,
					"transform.scaleY": scale,
					"transform.rotate": Math.min(Math.max(next.rotate, -360), 360),
					opacity: next.opacity / 100,
					...(next.kind === "audio"
						? { volume: gainToDb({ gain: next.volume }) }
						: {}),
				},
			};
			if (!next.full) {
				elementPatch.startTime = mediaTimeFromSeconds({ seconds: next.start });
				elementPatch.duration = mediaTimeFromSeconds({ seconds: next.dur });
			} else {
				elementPatch.startTime = mediaTimeFromSeconds({ seconds: 0 });
				elementPatch.duration = mediaTimeFromSeconds({ seconds: totalDuration });
			}
			editor.timeline.updateElements({
				updates: [{ trackId: draft.trackId, elementId: draft.elementId, patch: elementPatch }],
			});
		},
		[canvasHeight, canvasWidth, editor, totalDuration],
	);

	const handleField = useCallback(
		async ({ id, patch, optimistic = true }: { id: string; patch: Partial<KlipBrandLayer>; optimistic?: boolean }) => {
			const draft = layers.find((l) => l.id === id);
			if (!draft) return;
			if (optimistic) {
				setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
				applyTransformToElement({ draft, patch });
			}
			try {
				await patchLayer({ id, patch: patch as Record<string, unknown> });
			} catch (error) {
				console.error("Brand panel: PATCH failed", error);
				toast.error(error instanceof Error ? error.message : "Update failed");
				void refresh();
			}
		},
		[applyTransformToElement, layers, patchLayer, refresh],
	);

	const handleToggle = useCallback(
		({ id }: { id: string }) => {
			const draft = layers.find((l) => l.id === id);
			if (!draft) return;
			void handleField({ id, patch: { enabled: !draft.enabled } });
		},
		[handleField, layers],
	);

	const handleSwapZ = useCallback(
		async ({ id, dir }: { id: string; dir: 1 | -1 }) => {
			const sorted = [...layers].sort((a, b) => a.z - b.z);
			const idx = sorted.findIndex((l) => l.id === id);
			const other = sorted[idx + dir];
			const self = sorted[idx];
			if (!other || !self) return;
			try {
				await patchLayer({ id: self.id, patch: { z: other.z } });
				await patchLayer({ id: other.id, patch: { z: self.z } });
				// Mirror the swap in the timeline so the visual stacking
				// updates immediately (undoable via ReorderElementsCommand).
				if (
					self.elementId &&
					other.elementId &&
					self.trackId &&
					self.trackId === other.trackId
				) {
					editor.timeline.reorderElements({
						trackId: self.trackId,
						firstElementId: self.elementId,
						secondElementId: other.elementId,
					});
				}
				void refresh();
			} catch (error) {
				console.error("Brand panel: z-order swap failed", error);
				toast.error("Reorder failed");
			}
		},
		[editor, klipProjectId, layers, patchLayer, refresh],
	);

	const handleDelete = useCallback(
		async ({ id }: { id: string }) => {
			if (!klipProjectId) return;
			const draft = layers.find((l) => l.id === id);
			try {
				if (draft?.elementId && draft?.trackId) {
					editor.timeline.deleteElements({
						elements: [{ trackId: draft.trackId, elementId: draft.elementId }],
					});
				}
				const res = await fetch(
					`/api/klip/projects/${klipProjectId}/brand?layerId=${encodeURIComponent(id)}`,
					{ method: "DELETE" },
				);
				if (!res.ok) throw new Error(`DELETE failed: ${res.status}`);
				setLayers((prev) => prev.filter((l) => l.id !== id));
				if (selectedId === id) setSelectedId(null);
			} catch (error) {
				console.error("Brand panel: delete failed", error);
				toast.error("Delete failed");
				void refresh();
			}
		},
		[editor, klipProjectId, layers, refresh, selectedId],
	);

	const handleUpload = useCallback(
		async ({ files }: { files: FileList | null }) => {
			if (!files || files.length === 0 || !klipProjectId) return;
			setUploading(true);
			try {
				for (const file of files) {
					const form = new FormData();
					form.append("file", file);
					const up = await fetch("/api/klip/brand-assets", { method: "POST", body: form });
					if (!up.ok) {
						const body = (await up.json().catch(() => null)) as { error?: string } | null;
						throw new Error(body?.error ?? `Upload failed: ${up.status}`);
					}
					const asset = (await up.json()) as {
						mediaId: string;
						url: string;
						kind: KlipBrandKind;
						width: number | null;
						height: number | null;
						duration: number | null;
					};
					const create = await fetch(`/api/klip/projects/${klipProjectId}/brand`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							kind: asset.kind,
							file: asset.url.startsWith("/api/media/")
								? `brand/${asset.mediaId}${fileExtension({ filename: file.name })}`
								: `brand/${asset.mediaId}`,
							assetId: asset.mediaId,
							name: file.name.replace(/\.[^.]+$/, "").slice(0, 255) || "Brand layer",
						}),
					});
					if (!create.ok) throw new Error(`Create layer failed: ${create.status}`);
				}
				toast.success("Brand asset uploaded");
				await refresh();
			} catch (error) {
				console.error("Brand panel: upload failed", error);
				toast.error(error instanceof Error ? error.message : "Upload failed");
			} finally {
				setUploading(false);
				if (fileRef.current) fileRef.current.value = "";
			}
		},
		[klipProjectId, refresh],
	);

	const handleAddToTimeline = useCallback(
		async ({ id }: { id: string }) => {
			const draft = layers.find((l) => l.id === id);
			if (!draft) return;
			try {
				const { element } = klipLayerToElement(draft, {
					canvasWidth,
					canvasHeight,
					totalDuration,
				});
				// Snapshot existing element ids so the newly inserted one is
				// identified by diff — deterministic for a single insert,
				// unlike matching by name/mediaId (breaks on duplicates).
				const sceneBefore = editor.scenes.getActiveScene();
				const idsBefore = new Set<string>();
				for (const track of [
					...sceneBefore.tracks.overlay,
					sceneBefore.tracks.main,
					...sceneBefore.tracks.audio,
				]) {
					for (const e of track.elements) idsBefore.add(e.id);
				}
				editor.timeline.insertElement({
					placement: { mode: "auto" },
					element,
				});
				const scene = editor.scenes.getActiveScene();
				const allTracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
				let found: { trackId: string; elementId: string } | null = null;
				for (const track of allTracks) {
					const match = track.elements.find((e) => !idsBefore.has(e.id));
					if (match) {
						found = { trackId: track.id, elementId: match.id };
						break;
					}
				}
				if (found) {
					setLayers((prev) =>
						prev.map((l) =>
							l.id === id ? { ...l, elementId: found!.elementId, trackId: found!.trackId } : l,
						),
					);
				}
				toast.success(`Added "${draft.name}" to timeline`);
			} catch (error) {
				console.error("Brand panel: insert failed", error);
				toast.error("Failed to add to timeline");
			}
		},
		[canvasHeight, canvasWidth, editor, layers, totalDuration],
	);

	const selected = layers.find((l) => l.id === selectedId) ?? null;

	if (!project) {
		return (
			<div className="text-muted-foreground p-4 text-sm">
				Open a project to manage brand layers.
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b p-2">
				<input
					ref={fileRef}
					type="file"
					className="hidden"
					multiple
					accept=".png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.mp3,.wav,.m4a,.ogg"
					onChange={(e) => void handleUpload({ files: e.target.files })}
				/>
				<Button
					size="sm"
					variant="default"
					className="w-full gap-1"
					disabled={uploading || !klipProjectId}
					onClick={() => fileRef.current?.click()}
				>
					{uploading ? <Spinner className="size-4" /> : <HugeiconsIcon icon={Add01Icon} className="size-4" />}
					{uploading ? "Uploading..." : "Upload brand asset"}
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner className="text-muted-foreground size-6" />
					</div>
				) : layers.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 p-4">
						<HugeiconsIcon icon={Layers01Icon} className="text-muted-foreground size-10" />
						<div className="flex flex-col gap-1 text-center">
							<p className="text-sm font-medium">No brand layers yet</p>
							<p className="text-muted-foreground text-xs text-balance">
								Upload a logo, lower-third, or sting — then add it to the timeline.
							</p>
						</div>
					</div>
				) : (
					<ul className="flex flex-col gap-1 p-2">
						{[...layers]
							.sort((a, b) => b.z - a.z)
							.map((layer, i, arr) => (
								<li
									key={layer.id}
									className={cn(
										"flex items-center gap-1 rounded-md border p-1.5",
										selectedId === layer.id ? "border-primary" : "border-transparent hover:border-muted",
									)}
								>
									<button
										type="button"
										title={layer.enabled ? "Hide" : "Show"}
										className="text-muted-foreground hover:text-foreground shrink-0 p-1"
										onClick={() => handleToggle({ id: layer.id })}
									>
										<HugeiconsIcon icon={layer.enabled ? ViewIcon : ViewOffIcon} className="size-4" />
									</button>
									<button
										type="button"
										className="min-w-0 flex-1 truncate text-left text-xs font-medium"
										title={layer.name}
										onClick={() => setSelectedId(layer.id === selectedId ? null : layer.id)}
									>
										{layer.name}
										<span className="text-muted-foreground ml-1 font-normal">· {layer.kind}</span>
									</button>
									<button
										type="button"
										title="Move up"
										disabled={i === 0}
										className="text-muted-foreground hover:text-foreground shrink-0 p-1 disabled:opacity-30"
										onClick={() => void handleSwapZ({ id: layer.id, dir: 1 })}
									>
										<HugeiconsIcon icon={ArrowUp01Icon} className="size-4" />
									</button>
									<button
										type="button"
										title="Move down"
										disabled={i === arr.length - 1}
										className="text-muted-foreground hover:text-foreground shrink-0 p-1 disabled:opacity-30"
										onClick={() => void handleSwapZ({ id: layer.id, dir: -1 })}
									>
										<HugeiconsIcon icon={ArrowDown01Icon} className="size-4" />
									</button>
									<button
										type="button"
										title="Delete"
										className="text-muted-foreground hover:text-destructive shrink-0 p-1"
										onClick={() => void handleDelete({ id: layer.id })}
									>
										<HugeiconsIcon icon={Delete02Icon} className="size-4" />
									</button>
								</li>
							))}
					</ul>
				)}
				{selected && (
					<LayerInspector
						key={selected.id}
						layer={selected}
						totalDuration={totalDuration}
						onAdd={() => void handleAddToTimeline({ id: selected.id })}
						onField={(patch) => void handleField({ id: selected.id, patch })}
					/>
				)}
			</div>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<Label className="text-xs">{label}</Label>
			{children}
		</div>
	);
}

function LayerInspector({
	layer,
	totalDuration,
	onAdd,
	onField,
}: {
	layer: Draft;
	totalDuration: number;
	onAdd: () => void;
	onField: (patch: Partial<KlipBrandLayer>) => void;
}) {
	const [volumeDb, setVolumeDb] = useState(() => gainToDb({ gain: layer.volume || GAIN_DEFAULT }));
	useEffect(() => {
		setVolumeDb(gainToDb({ gain: layer.volume || GAIN_DEFAULT }));
	}, [layer.id, layer.volume]);

	const num = (value: string, fallback: number): number => {
		const n = Number(value);
		return Number.isFinite(n) ? n : fallback;
	};

	return (
		<div className="flex flex-col gap-3 border-t p-3">
			<div className="flex items-center justify-between gap-2">
				<p className="truncate text-xs font-semibold">{layer.name}</p>
				<Button size="sm" variant="secondary" onClick={onAdd}>
					Add to timeline
				</Button>
			</div>

			<Field label={`Scale (${layer.scale.toFixed(2)})`}>
				<Slider
					value={[layer.scale]}
					min={0.01}
					max={3}
					step={0.01}
					onValueChange={([v]) => v !== undefined && onField({ scale: v })}
				/>
			</Field>

			<div className="grid grid-cols-2 gap-2">
				<Field label="Position X">
					<Input
						size="sm"
						type="number"
						step={0.01}
						min={0}
						max={1}
						defaultValue={layer.x}
						key={`x-${layer.id}-${layer.x}`}
						onBlur={(e) => onField({ x: num(e.target.value, layer.x) })}
					/>
				</Field>
				<Field label="Position Y">
					<Input
						size="sm"
						type="number"
						step={0.01}
						min={0}
						max={1}
						defaultValue={layer.y}
						key={`y-${layer.id}-${layer.y}`}
						onBlur={(e) => onField({ y: num(e.target.value, layer.y) })}
					/>
				</Field>
			</div>

			<div className="grid grid-cols-2 gap-2">
				<Field label="Rotate (°)">
					<Input
						size="sm"
						type="number"
						step={1}
						min={-360}
						max={360}
						defaultValue={layer.rotate}
						key={`r-${layer.id}-${layer.rotate}`}
						onBlur={(e) => onField({ rotate: num(e.target.value, layer.rotate) })}
					/>
				</Field>
				<Field label={`Opacity (${layer.opacity}%)`}>
					<Slider
						value={[layer.opacity]}
						min={0}
						max={100}
						step={1}
						onValueChange={([v]) => v !== undefined && onField({ opacity: Math.round(v) })}
					/>
				</Field>
			</div>

			<div className="flex items-center justify-between gap-2">
				<Label className="text-xs">Full duration</Label>
				<Switch checked={layer.full} onCheckedChange={(full) => onField({ full })} />
			</div>

			{!layer.full && (
				<div className="grid grid-cols-2 gap-2">
					<Field label="Start (s)">
						<Input
							size="sm"
							type="number"
							step={0.1}
							min={0}
							defaultValue={layer.start}
							key={`s-${layer.id}-${layer.start}`}
							onBlur={(e) =>
								onField({
									start: Math.max(0, num(e.target.value, layer.start)),
									dur: layer.dur > 0 ? layer.dur : Math.max(0.1, totalDuration - Math.max(0, num(e.target.value, layer.start))),
								})
							}
						/>
					</Field>
					<Field label="Duration (s)">
						<Input
							size="sm"
							type="number"
							step={0.1}
							min={0.1}
							defaultValue={layer.dur > 0 ? layer.dur : totalDuration}
							key={`d-${layer.id}-${layer.dur}`}
							onBlur={(e) => onField({ dur: Math.max(0.1, num(e.target.value, layer.dur || totalDuration)) })}
						/>
					</Field>
				</div>
			)}

			{layer.kind === "audio" && (
				<>
					<Field label={`Volume (${toDbLabel({ db: volumeDb })})`}>
						<Slider
							value={[volumeDb]}
							min={VOLUME_DB_MIN}
							max={VOLUME_DB_MAX}
							step={0.5}
							onValueChange={([v]) => {
								if (v === undefined) return;
								setVolumeDb(v);
								onField({ volume: dbToGain({ db: v }) });
							}}
						/>
					</Field>
					<div className="flex items-center justify-between gap-2">
						<Label className="text-xs">Duck under dialogue</Label>
						<Switch checked={layer.duck} onCheckedChange={(duck) => onField({ duck })} />
					</div>
				</>
			)}
			{layer.elementId && (
				<p className="text-muted-foreground text-[11px]">
					Linked to timeline element — edits update it live. Delete removes both.
				</p>
			)}
		</div>
	);
}
