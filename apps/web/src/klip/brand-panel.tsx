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
import { processMediaAssets } from "@/media/processing";
import {
	type KlipBrandKind,
	type KlipBrandLayer,
	elementToKlipLayer,
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

type Draft = KlipBrandLayer & {
	elementId: string | null;
	trackId: string | null;
	assetWidth: number | null;
	assetHeight: number | null;
};

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
	const [templates, setTemplates] = useState<Array<{ id: string; name: string; layerCount: number }>>([]);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
	const [templateName, setTemplateName] = useState("");
	const [applying, setApplying] = useState(false);
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
					assetWidth: prevById.get(l.id)?.assetWidth ?? null,
					assetHeight: prevById.get(l.id)?.assetHeight ?? null,
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
		void (async () => {
			try {
				const res = await fetch("/api/klip/brand-templates");
				if (!res.ok) return;
				const body = (await res.json()) as {
					templates: Array<{ id: string; name: string; layerCount: number }>;
				};
				setTemplates(body.templates);
			} catch (error) {
				console.error("Brand panel: failed to load templates", error);
			}
		})();
	}, [refresh]);

	// Sync balik: geser/resize di canvas/timeline tulis balik ke DB via
	// elementToKlipLayer. Hanya field yang teramati (tanpa z/duck agar tidak
	// tertimpa), PATCH di-debounce per layer. Nilai yang sama persis (hasil
	// tulis panel sendiri) jadi no-op sehingga tidak ada loop.
	const layersRef = useRef(layers);
	layersRef.current = layers;
	const syncCtxRef = useRef({ klipProjectId, canvasWidth, canvasHeight, totalDuration });
	syncCtxRef.current = { klipProjectId, canvasWidth, canvasHeight, totalDuration };
	const pendingPatchRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(() => {
		return () => {
			for (const t of pendingPatchRef.current.values()) clearTimeout(t);
			pendingPatchRef.current.clear();
		};
	}, []);
	useEffect(() => {
		const EPS = 1e-4;
		const close = (a: number, b: number) => Math.abs(a - b) < EPS;
		const syncFromTimeline = () => {
			const ctx = syncCtxRef.current;
			if (!ctx.klipProjectId) return;
			let scene: ReturnType<typeof editor.scenes.getActiveScene>;
			try {
				scene = editor.scenes.getActiveScene();
			} catch {
				return;
			}
			const tracks = [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio];
			const mediaAssets = editor.media.getAssets();
			for (const draft of layersRef.current) {
				if (!draft.elementId || !draft.trackId) continue;
				const track = tracks.find((t) => t.id === draft.trackId);
				const element = track?.elements.find((e) => e.id === draft.elementId);
				if (!element) continue;
				const mediaId = "mediaId" in element ? element.mediaId : null;
				const media = mediaAssets.find((a) => a.id === mediaId);
				const assetWidth = draft.assetWidth ?? media?.width ?? null;
				const assetHeight = draft.assetHeight ?? media?.height ?? null;
				const raw = elementToKlipLayer(element, {
					canvasWidth: ctx.canvasWidth,
					canvasHeight: ctx.canvasHeight,
					totalDuration: ctx.totalDuration,
					assetWidth,
					assetHeight,
				});
				// Snap full dengan epsilon (konversi detik<->ticks tidak selalu exact).
				const full =
					raw.full || (Math.abs(raw.start) < 1e-3 && Math.abs(raw.dur - ctx.totalDuration) < 1e-3);
				const patch: Partial<KlipBrandLayer> = {
					enabled: raw.enabled,
					x: raw.x,
					y: raw.y,
					scale: raw.scale,
					rotate: raw.rotate,
					opacity: raw.opacity,
					full,
					start: full ? 0 : raw.start,
					dur: full ? 0 : raw.dur,
				};
				if (draft.kind === "audio" && raw.volume !== undefined) patch.volume = raw.volume;
				const same =
					patch.enabled === draft.enabled &&
					close(patch.x!, draft.x) &&
					close(patch.y!, draft.y) &&
					close(patch.scale!, draft.scale) &&
					close(patch.rotate!, draft.rotate) &&
					close(patch.opacity!, draft.opacity) &&
					patch.full === draft.full &&
					close(patch.start!, draft.start) &&
					close(patch.dur!, draft.dur) &&
					(patch.volume === undefined || close(patch.volume, draft.volume));
				if (same) continue;
				const projectId = ctx.klipProjectId;
				const id = draft.id;
				setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
				if (pendingPatchRef.current.has(id)) continue;
				pendingPatchRef.current.set(
					id,
					setTimeout(() => {
						pendingPatchRef.current.delete(id);
						fetch(`/api/klip/projects/${projectId}/brand`, {
							method: "PATCH",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id, ...patch }),
						}).catch((error) => console.error("Brand panel: reverse sync PATCH failed", error));
					}, 600),
				);
			}
		};
		const un1 = editor.timeline.subscribe(syncFromTimeline);
		const un2 = editor.scenes.subscribe(syncFromTimeline);
		return () => {
			un1();
			un2();
		};
	}, [editor]);

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
					l.id === id
						? {
								...body.layer,
								elementId: l.elementId,
								trackId: l.trackId,
								assetWidth: l.assetWidth,
								assetHeight: l.assetHeight,
							}
						: l,
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
					// Video/audio memakai durasi natural file (jendela di 0), bukan
					// full-main; image (WM) tetap full seperti sebelumnya.
					const timed = asset.kind !== "image";
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
							full: !timed,
							start: 0,
							dur: timed && typeof asset.duration === "number" ? asset.duration : 0,
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

	const insertDraftToTimeline = useCallback(
		async ({ draft }: { draft: Draft }) => {
			if (!project) {
				toast.error("No active project");
				return;
			}
			try {
				// The renderer only knows media registered in the browser media
				// bin (scene-builder skips elements whose mediaId is unknown).
				// So fetch the brand file from the server and register it
				// first; the returned browser id becomes the element mediaId.
				const serverId = draft.asset_id ?? draft.file;
				const fileRes = await fetch(`/api/media/${encodeURIComponent(serverId)}`);
				if (!fileRes.ok) {
					throw new Error(`Brand file not found on server: ${serverId}`);
				}
				const blob = await fileRes.blob();
				const ext = fileExtension({ filename: draft.file });
				const file = new File([blob], `${draft.name}${ext}`, {
					type: blob.type || undefined,
				});
				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed) throw new Error("Failed to process brand file");
				const saved = await editor.media.addMediaAsset({
					projectId: project.metadata.id,
					asset: processed,
				});
				if (!saved) throw new Error("Failed to register brand media");

				const { element } = klipLayerToElement(
					{ ...draft, asset_id: saved.id, file: saved.id },
					{
						canvasWidth,
						canvasHeight,
						totalDuration,
						assetWidth: saved.width ?? undefined,
						assetHeight: saved.height ?? undefined,
					},
				);
				// Ensure the mapped element points at the registered media.
				const mapped = { ...element, mediaId: saved.id };
				// Snapshot existing element ids so the newly inserted one is
				// identified by diff — deterministic for a single insert,
				// unlike matching by name/mediaId (breaks on duplicates).
				const sceneBefore = editor.scenes.getActiveScene();
				const idsBefore = new Set<string>();
				for (const track of [
					sceneBefore.tracks.main,
					...sceneBefore.tracks.overlay,
					...sceneBefore.tracks.audio,
				]) {
					for (const e of track.elements) idsBefore.add(e.id);
				}
				editor.timeline.insertElement({
					placement: { mode: "auto" },
					element: mapped,
				});
				const scene = editor.scenes.getActiveScene();
				const allTracks = [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio];
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
							l.id === draft.id
								? {
										...l,
										elementId: found!.elementId,
										trackId: found!.trackId,
										assetWidth: saved.width ?? null,
										assetHeight: saved.height ?? null,
									}
								: l,
						),
					);
				}
				toast.success(`Added "${draft.name}" to timeline`);
			} catch (error) {
				console.error("Brand panel: insert failed", error);
				toast.error("Failed to add to timeline");
			}
		},
		[canvasHeight, canvasWidth, editor, totalDuration],
	);

	const handleAddToTimeline = useCallback(
		({ id }: { id: string }) => {
			const draft = layers.find((l) => l.id === id);
			if (!draft) return;
			void insertDraftToTimeline({ draft });
		},
		[layers, insertDraftToTimeline],
	);

	const handleSaveAsTemplate = useCallback(async () => {
		if (!klipProjectId || !templateName.trim()) return;
		try {
			const res = await fetch(`/api/klip/projects/${klipProjectId}/save-as-template`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: templateName.trim() }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Save failed: ${res.status}`);
			}
			const body = (await res.json()) as {
				template: { id: string; name: string };
				layerCount: number;
			};
			setTemplates((prev) => [...prev, { ...body.template, layerCount: body.layerCount }]);
			setSelectedTemplateId(body.template.id);
			setTemplateName("");
			toast.success(`Template "${body.template.name}" saved`);
		} catch (error) {
			console.error("Brand panel: save-as-template failed", error);
			toast.error(error instanceof Error ? error.message : "Save failed");
		}
	}, [klipProjectId, templateName]);

	const handleApplyTemplate = useCallback(async () => {
		if (!klipProjectId || !selectedTemplateId || !project) return;
		setApplying(true);
		try {
			const res = await fetch(`/api/klip/projects/${klipProjectId}/apply-template`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ templateId: selectedTemplateId, mainDuration: totalDuration }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Apply failed: ${res.status}`);
			}
			const body = (await res.json()) as { layers: KlipBrandLayer[]; totalDuration: number };
			const drafts: Draft[] = body.layers.map((l) => ({
				...l,
				elementId: null,
				trackId: null,
				assetWidth: null,
				assetHeight: null,
			}));
			setLayers(drafts);
			// Sekuensial: insert memakai diff id sebelum/sesudah, concurrent akan merusak diff.
			for (const draft of drafts) {
				await insertDraftToTimeline({ draft });
			}
			if (body.totalDuration > totalDuration) {
				toast.info(
					`Template extends timeline to ${body.totalDuration.toFixed(1)}s - extend the project duration to match.`,
				);
			} else {
				toast.success("Template applied");
			}
		} catch (error) {
			console.error("Brand panel: apply-template failed", error);
			toast.error(error instanceof Error ? error.message : "Apply failed");
			void refresh();
		} finally {
			setApplying(false);
		}
	}, [insertDraftToTimeline, klipProjectId, project, refresh, selectedTemplateId, totalDuration]);

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
			<div className="flex flex-col gap-2 border-b p-2">
				<div className="flex items-center gap-2">
					<select
						className="bg-background min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs"
						value={selectedTemplateId}
						onChange={(e) => setSelectedTemplateId(e.target.value)}
						disabled={applying || !klipProjectId}
						title="Brand template"
					>
						<option value="">Select template...</option>
						{templates.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name} ({t.layerCount})
							</option>
						))}
					</select>
					<Button
						size="sm"
						variant="secondary"
						disabled={applying || !klipProjectId || !selectedTemplateId}
						onClick={() => void handleApplyTemplate()}
					>
						{applying ? <Spinner className="size-4" /> : "Apply"}
					</Button>
				</div>
				<div className="flex items-center gap-2">
					<Input
						placeholder="Template name..."
						value={templateName}
						onChange={(e) => setTemplateName(e.target.value)}
						disabled={!klipProjectId}
						className="h-8 text-xs"
					/>
					<Button
						size="sm"
						variant="ghost"
						disabled={!klipProjectId || !templateName.trim()}
						onClick={() => void handleSaveAsTemplate()}
					>
						Save as
					</Button>
				</div>
			</div>
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
				<Switch
					checked={layer.full}
					onCheckedChange={(full) =>
						onField(full ? { full, anchor: "start", start: 0, dur: 0 } : { full })
					}
				/>
			</div>

			{!layer.full && (
				<div className="flex items-center justify-between gap-2">
					<Label className="text-xs">Di akhir video</Label>
					<Switch
						checked={layer.anchor === "main_end"}
						onCheckedChange={(on) =>
							onField({
								anchor: on ? "main_end" : "start",
								...(on ? { start: 0 } : {}),
							})
						}
					/>
				</div>
			)}

			{!layer.full && (
				<div className={layer.anchor === "main_end" ? "" : "grid grid-cols-2 gap-2"}>
					{layer.anchor !== "main_end" && (
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
					)}
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
