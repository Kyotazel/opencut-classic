import { describe, expect, test } from "bun:test";
import {
	resolveTemplateLayer,
	resolveTotalDuration,
} from "@/klip/template-resolve";

describe("template-resolve", () => {
	test("full spans main duration", () => {
		expect(
			resolveTemplateLayer({ anchor: "start", full: true, start: 99, dur: 99 }, 50),
		).toEqual({ start: 0, dur: 50 });
	});
	test("fixed slot passes through", () => {
		expect(
			resolveTemplateLayer({ anchor: "start", full: false, start: 120, dur: 30 }, 50),
		).toEqual({ start: 120, dur: 30 });
	});
	test("main_end offsets from main duration", () => {
		const r = resolveTemplateLayer(
			{ anchor: "main_end", full: false, start: 0.1, dur: 20 },
			50,
		);
		expect(r.start).toBeCloseTo(50.1, 9);
		expect(r.dur).toBe(20);
	});
	test("total extends for appended ads", () => {
		expect(
			resolveTotalDuration(50, [
				{ start: 0, dur: 50 },
				{ start: 50.1, dur: 20 },
			]),
		).toBeCloseTo(70.1, 9);
	});

	test("post-roll menempel tepat di ujung video 25 detik", () => {
		// Layer ditandai "di akhir video": start 0, dur 7 (ads).
		const r = resolveTemplateLayer(
			{ anchor: "main_end", full: false, start: 0, dur: 7 },
			25,
		);
		expect(r.start).toBeCloseTo(25, 9);
		expect(r.dur).toBe(7);
	});

	test("post-roll yang sama menempel di ujung video 30 detik", () => {
		// Template identik harus ikut bergeser ke 30, bukan tetap di 25.
		const r = resolveTemplateLayer(
			{ anchor: "main_end", full: false, start: 0, dur: 7 },
			30,
		);
		expect(r.start).toBeCloseTo(30, 9);
		expect(r.dur).toBe(7);
	});

	test("total duration memanjang 30 + 7 = 37", () => {
		const layer = resolveTemplateLayer(
			{ anchor: "main_end", full: false, start: 0, dur: 7 },
			30,
		);
		expect(resolveTotalDuration(30, [layer])).toBeCloseTo(37, 9);
	});
});
