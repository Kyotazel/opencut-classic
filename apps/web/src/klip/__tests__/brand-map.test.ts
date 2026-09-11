import { describe, expect, test } from "bun:test";
import "@/klip/brand-map";
import type { MediaTime } from "@/wasm";

const ZERO_TICKS = 0 as MediaTime;
const mediaTime = ({ ticks }: { ticks: number }): MediaTime => {
	if (!Number.isInteger(ticks)) throw new Error("test: non-integer ticks");
	return ticks as MediaTime;
};
import type { ImageElement, UploadAudioElement } from "@/timeline";
import {
	elementToKlipLayer,
	klipLayerToElement,
} from "@/klip/brand-map";
import type { ParamValues } from "@/params";

const num = (params: ParamValues, key: string): number => {
	const v = params[key];
	if (typeof v !== "number") throw new Error(`test: param ${key} not a number`);
	return v;
};

const CTX = {
	canvasWidth: 1080,
	canvasHeight: 1920,
	totalDuration: 55.8,
	assetWidth: 540,
	assetHeight: 200,
};

describe("klipLayerToElement", () => {
	test("full image → graphic track element", () => {
		const { track, element } = klipLayerToElement(
			{
				id: "lyr_1",
				asset_id: null,
				file: "brand/wm.png",
				name: "wm",
				kind: "image",
				enabled: true,
				x: 0.62,
				y: 0.06,
				scale: 0.3,
				rotate: 0,
				start: 0,
				dur: 0,
				full: true,
				anchor: "start",
				volume: 0.35,
				duck: false,
				opacity: 100,
				z: 0,
			},
			CTX,
		);
		expect(track).toBe("graphic");
		expect(element.type).toBe("image");
	});

	test("full image maps start/duration ticks and params", () => {
		const { element } = klipLayerToElement(
			{
				id: "lyr_1",
				asset_id: null,
				file: "brand/wm.png",
				name: "wm",
				kind: "image",
				enabled: true,
				x: 0.62,
				y: 0.06,
				scale: 0.3,
				rotate: 0,
				start: 0,
				dur: 0,
				full: true,
				anchor: "start",
				volume: 0.35,
				duck: false,
				opacity: 100,
				z: 0,
			},
			CTX,
		);
		if (element.type !== "image") {
			throw new Error(`expected image element, got ${element.type}`);
		}
		// full=true → (0, totalDuration); 55.8s × 120000 ticks/s = 6696000
		expect(Number(element.startTime)).toBe(ZERO_TICKS);
		expect(Number(element.duration)).toBe(6696000);
		expect(element.name).toBe("wm");
		// asset_id null → file path becomes the media id
		expect(element.mediaId).toBe("brand/wm.png");
		expect(element.hidden).toBe(false);
		// posX = (0.62-0.5)*1080 = 129.6; posY = (0.5-0.06)*1920 = 844.8
		expect(num(element.params, "transform.positionX")).toBeCloseTo(129.6, 9);
		expect(num(element.params, "transform.positionY")).toBeCloseTo(844.8, 9);
		// scale = 0.3 * 1080 / 540 = 0.6
		expect(num(element.params, "transform.scaleX")).toBeCloseTo(0.6, 9);
		expect(num(element.params, "transform.scaleY")).toBeCloseTo(0.6, 9);
		expect(element.params["transform.rotate"]).toBe(0);
		expect(element.params["opacity"]).toBe(1);
		// visual elements never carry a volume param
		expect("volume" in element.params).toBe(false);
	});

	test("audio → audio track element with volume in dB", () => {
		const { track, element } = klipLayerToElement(
			{
				id: "lyr_a",
				asset_id: "m_abc123",
				file: "brand/song.mp3",
				name: "song",
				kind: "audio",
				enabled: true,
				x: 0.5,
				y: 0.5,
				scale: 1,
				rotate: 0,
				start: 2,
				dur: 10,
				full: false,
				anchor: "start",
				volume: 0.35,
				duck: true,
				opacity: 100,
				z: 1,
			},
			CTX,
		);
		expect(track).toBe("audio");
		expect(element.type).toBe("audio");
		if (element.type !== "audio" || element.sourceType !== "upload") {
			throw new Error("expected upload audio element");
		}
		expect(element.mediaId).toBe("m_abc123");
		expect(Number(element.startTime)).toBe(2 * 120000);
		expect(Number(element.duration)).toBe(10 * 120000);
		// gain 0.35 → 20*log10(0.35) dB
		expect(num(element.params, "volume")).toBeCloseTo(20 * Math.log10(0.35), 9);
	});

	test("timed video → video track element", () => {
		const { track, element } = klipLayerToElement(
			{
				id: "lyr_v",
				asset_id: "m_vid1",
				file: "brand/clip.mp4",
				name: "clip",
				kind: "video",
				enabled: false,
				x: 0.5,
				y: 0.5,
				scale: 1,
				rotate: 0,
				start: 1.5,
				dur: 12,
				full: false,
				anchor: "start",
				volume: 0.35,
				duck: false,
				opacity: 80,
				z: 2,
			},
			CTX,
		);
		expect(track).toBe("video");
		expect(element.type).toBe("video");
		if (element.type !== "video") {
			throw new Error(`expected video element, got ${element.type}`);
		}
		expect(Number(element.startTime)).toBe(1.5 * 120000);
		expect(Number(element.duration)).toBe(12 * 120000);
		expect(element.hidden).toBe(true);
		expect(num(element.params, "opacity")).toBeCloseTo(0.8, 9);
	});
});

describe("elementToKlipLayer", () => {
	test("image element patch omits volume", () => {
		const element: ImageElement = {
			id: "el_1",
			type: "image",
			name: "wm",
			mediaId: "brand/wm.png",
			startTime: ZERO_TICKS,
			duration: mediaTime({ ticks: 6696000 }),
			trimStart: ZERO_TICKS,
			trimEnd: ZERO_TICKS,
			hidden: false,
			params: {
				"transform.positionX": 129.6,
				"transform.positionY": 844.8,
				"transform.scaleX": 0.6,
				"transform.scaleY": 0.6,
				"transform.rotate": 0,
				opacity: 1,
			},
		};
		const patch = elementToKlipLayer(element, CTX);
		expect(patch.full).toBe(true);
		expect(patch.start).toBe(0);
		expect(patch.dur).toBe(0);
		expect(patch.x).toBeCloseTo(0.62, 6);
		expect(patch.y).toBeCloseTo(0.06, 6);
		expect(patch.enabled).toBe(true);
		expect("volume" in patch).toBe(false);
	});

	test("audio element patch includes volume as gain", () => {
		const element: UploadAudioElement = {
			id: "el_a",
			type: "audio",
			sourceType: "upload",
			name: "song",
			mediaId: "m_abc123",
			startTime: mediaTime({ ticks: 2 * 120000 }),
			duration: mediaTime({ ticks: 10 * 120000 }),
			trimStart: ZERO_TICKS,
			trimEnd: ZERO_TICKS,
			sourceDuration: mediaTime({ ticks: 10 * 120000 }),
			params: {
				volume: 0,
				muted: false,
			},
		};
		const patch = elementToKlipLayer(element, CTX);
		expect(patch.full).toBe(false);
		expect(patch.start).toBe(2);
		expect(patch.dur).toBe(10);
		// 0 dB → gain 1.0
		expect(patch.volume).toBeCloseTo(1, 9);
	});
});


describe("round-trip posisi", () => {
	test("layer → element → layer mengembalikan x/y/scale (kiri-atas)", () => {
		const { element } = klipLayerToElement(
			{
				id: "lyr_rt",
				asset_id: null,
				file: "brand/wm.png",
				name: "wm",
				kind: "image",
				enabled: true,
				x: 0.18,
				y: 0.85,
				scale: 0.42,
				rotate: 0,
				start: 5,
				dur: 9.53,
				full: false,
				anchor: "start",
				volume: 0.35,
				duck: false,
				opacity: 100,
				z: 0,
			},
			CTX,
		);
		if (element.type !== "image") throw new Error("test: expected image element");
		const patch = elementToKlipLayer(
			{
				id: "el_rt",
				...element,
				trimEnd: ZERO_TICKS,
				hidden: false,
			},
			CTX,
		);
		expect(patch.x).toBeCloseTo(0.18, 9);
		expect(patch.y).toBeCloseTo(0.85, 9);
		expect(patch.scale).toBeCloseTo(0.42, 9);
		expect(patch.start).toBeCloseTo(5, 9);
		expect(patch.dur).toBeCloseTo(9.53, 9);
	});
});
