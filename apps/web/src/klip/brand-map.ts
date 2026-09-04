/**
 * Brand-map adapter: Klip brand layer ↔ opencut timeline element.
 *
 * TECH DEBT (sementara, diganti binding wasm asli): formula di bawah adalah
 * port 1:1 dari `rust/crates/klip/src/brand_map.rs` (kontrak skala identik,
 * diverifikasi test yang sama). Alasan: paket `opencut-wasm` yang dipakai app
 * adalah build registry (v0.2.10), bukan `rust/wasm/pkg` lokal — memasang
 * binding wasm baru butuh `wasm-pack build` + mengganti resolusi paket, yang
 * berisiko di tengah Slice 1. Penggantian: ekspos `klip_layer_to_element`
 * via `rust/wasm` + `wasm-pack build` + link `opencut-wasm` ke `rust/wasm/pkg`,
 * lalu adapter ini menjadi pemanggil tipis (hanya konversi detik↔MediaTime).
 *
 * Adapter ini SENGAJA tidak mengimpor `@/wasm` di level modul: runtime wasm
 * tidak bisa dimuat di `bun test` (pre-existing failure di semua test yang
 * memakai `@/wasm`). Konversi detik↔ticks memakai konstanta TICKS_PER_SECOND
 * yang sama dengan Rust (`rust/crates/time/src/media_time.rs`), dan hasilnya
 * tetap `MediaTime` valid (integer ticks). Konsumen UI (panel) memanggil
 * fungsi ini di browser di mana `@/wasm` sudah hidup — tidak ada konflik.
 */
import type { ParamValues } from "@/params";
import type {
	CreateAudioElement,
	CreateImageElement,
	CreateVideoElement,
	ImageElement,
	TimelineElement,
	UploadAudioElement,
} from "@/timeline/types";
import type { MediaTime } from "@/wasm";

/** Cermin `TICKS_PER_SECOND` Rust — satu-satunya dependensi ke wasm boundary. */
export const BRAND_MAP_TICKS_PER_SECOND = 120_000;

const ZERO_TICKS = 0 as MediaTime;

function mediaTimeFromSecondsLocal({ seconds }: { seconds: number }): MediaTime {
	const ticks = Math.round(seconds * BRAND_MAP_TICKS_PER_SECOND);
	if (!Number.isInteger(ticks)) {
		throw new Error(`brand-map: non-integer ticks for ${seconds}s`);
	}
	return ticks as MediaTime;
}

function mediaTimeToSecondsLocal({ time }: { time: MediaTime }): number {
	return (time as number) / BRAND_MAP_TICKS_PER_SECOND;
}

export const VOLUME_DB_MIN = -60;
export const VOLUME_DB_MAX = 20;
const MIN_LINEAR_GAIN = 10 ** (VOLUME_DB_MIN / 20);
const MIN_TRANSFORM_SCALE = 0.01;
const DEFAULT_VOLUME_GAIN = 0.35;

export type KlipBrandKind = "image" | "video" | "audio";
export type BrandTrack = "graphic" | "video" | "audio";

export interface KlipBrandLayer {
	id: string;
	asset_id: string | null;
	file: string;
	name: string;
	kind: KlipBrandKind;
	enabled: boolean;
	x: number;
	y: number;
	scale: number;
	rotate: number;
	start: number;
	dur: number;
	full: boolean;
	volume: number;
	duck: boolean;
	opacity: number;
	z: number;
}

export interface BrandMapCtx {
	canvasWidth: number;
	canvasHeight: number;
	totalDuration: number;
	assetWidth?: number | null;
	assetHeight?: number | null;
}

export type KlipLayerPatch = Omit<
	KlipBrandLayer,
	"id" | "asset_id" | "file" | "name" | "kind" | "volume"
> & { volume?: number };

function gainToDb(gain: number): number {
	const clamped = Math.max(gain, MIN_LINEAR_GAIN);
	const db = 20 * Math.log10(clamped);
	return Math.min(Math.max(db, VOLUME_DB_MIN), VOLUME_DB_MAX);
}

function dbToGain(db: number): number {
	return 10 ** (db / 20);
}

function clampRotate(deg: number): number {
	return Math.min(Math.max(deg, -360), 360);
}

/** Client-safe file extension (lowercased, with dot) — mirrors server ext sets. */
export function fileExtension({ filename }: { filename: string }): string {
	const idx = filename.lastIndexOf(".");
	if (idx === -1) return "";
	return filename.slice(idx).toLowerCase();
}

const trackForKind = (kind: KlipBrandKind): BrandTrack =>
	kind === "image" ? "graphic" : kind === "video" ? "video" : "audio";

export function klipLayerToElement(
	layer: KlipBrandLayer,
	ctx: BrandMapCtx,
): {
	track: BrandTrack;
	element: CreateImageElement | CreateVideoElement | CreateAudioElement;
} {
	const track = trackForKind(layer.kind);
	const [startSec, durationSec] = layer.full
		? [0, ctx.totalDuration]
		: [layer.start, layer.dur];

	const posX = (layer.x - 0.5) * ctx.canvasWidth;
	const posY = (0.5 - layer.y) * ctx.canvasHeight;

	const baseScale =
		ctx.assetWidth != null && ctx.assetWidth > 0
			? (layer.scale * ctx.canvasWidth) / ctx.assetWidth
			: layer.scale;
	const clampedScale = Math.max(baseScale, MIN_TRANSFORM_SCALE);

	const rotate = clampRotate(layer.rotate);
	const opacity = layer.opacity / 100;
	const hidden = !layer.enabled;
	const mediaId = layer.asset_id ?? layer.file;

	const params: ParamValues = {
		"transform.positionX": posX,
		"transform.positionY": posY,
		"transform.scaleX": clampedScale,
		"transform.scaleY": clampedScale,
		"transform.rotate": rotate,
		opacity,
	};

	const base = {
		name: layer.name,
		mediaId,
		startTime: mediaTimeFromSecondsLocal({ seconds: startSec }),
		duration: mediaTimeFromSecondsLocal({ seconds: durationSec }),
		trimStart: ZERO_TICKS,
		trimEnd: ZERO_TICKS,
		hidden,
	};

	if (layer.kind === "audio") {
		return {
			track,
			element: {
				...base,
				type: "audio",
				sourceType: "upload",
				sourceDuration: base.duration,
				params: { ...params, volume: gainToDb(layer.volume) },
			},
		};
	}
	if (layer.kind === "video") {
		return {
			track,
			element: {
				...base,
				type: "video",
				sourceDuration: base.duration,
				isSourceAudioEnabled: true,
				params,
			},
		};
	}
	return { track, element: { ...base, type: "image", params } };
}

export function elementToKlipLayer(
	element: TimelineElement,
	ctx: BrandMapCtx,
): KlipLayerPatch {
	const startSec = mediaTimeToSecondsLocal({ time: element.startTime });
	const durationSec = mediaTimeToSecondsLocal({ time: element.duration });
	const [full, start, dur] =
		startSec === 0 && durationSec === ctx.totalDuration
			? ([true, 0, 0] as const)
			: ([false, startSec, durationSec] as const);

	const posX = (element.params["transform.positionX"] as number) ?? 0;
	const posY = (element.params["transform.positionY"] as number) ?? 0;
	const scaleX = (element.params["transform.scaleX"] as number) ?? 1;
	const scaleY = (element.params["transform.scaleY"] as number) ?? 1;

	let scale: number;
	if (
		ctx.assetWidth != null &&
		ctx.assetWidth > 0 &&
		ctx.canvasWidth > 0
	) {
		scale = ((scaleX + scaleY) / 2) * (ctx.assetWidth / ctx.canvasWidth);
	} else {
		scale = (scaleX + scaleY) / 2;
	}

	const hidden =
		element.type === "video" ||
		element.type === "image" ||
		element.type === "text" ||
		element.type === "sticker" ||
		element.type === "graphic"
			? (element.hidden ?? false)
			: false;

	const patch: KlipLayerPatch = {
		enabled: !hidden,
		x: ctx.canvasWidth > 0 ? posX / ctx.canvasWidth + 0.5 : 0.5,
		y: ctx.canvasHeight > 0 ? 0.5 - posY / ctx.canvasHeight : 0.5,
		scale,
		rotate: clampRotate(
			(element.params["transform.rotate"] as number) ?? 0,
		),
		start,
		dur,
		full,
		duck: (element.params["duck"] as boolean) ?? false,
		opacity: ((element.params["opacity"] as number) ?? 1) * 100,
		z: 0,
	};

	if (element.type === "audio") {
		const volumeDb = (element.params["volume"] as number) ?? 0;
		patch.volume = dbToGain(volumeDb);
	}

	return patch;
}

export function mappedDurationTicks({
	startSec,
	durationSec,
}: {
	startSec: number;
	durationSec: number;
}): { startTime: number; duration: number } {
	const startTicks = Math.round(startSec * BRAND_MAP_TICKS_PER_SECOND);
	const durationTicks = Math.round(durationSec * BRAND_MAP_TICKS_PER_SECOND);
	if (!Number.isInteger(startTicks) || !Number.isInteger(durationTicks)) {
		throw new Error("brand-map: non-integer ticks");
	}
	return {
		startTime: (startTicks as MediaTime).valueOf(),
		duration: (durationTicks as MediaTime).valueOf(),
	};
}

export { DEFAULT_VOLUME_GAIN };
export type { ImageElement, UploadAudioElement };
