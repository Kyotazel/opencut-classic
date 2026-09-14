import { describe, expect, test } from "bun:test";
import { canvasSizeForVideo } from "@/klip/canvas-size";

/**
 * Pemilihan kanvas berdasarkan orientasi video.
 *
 * KENAPA INI ADA
 * Sebelumnya selalu dipakai DEFAULT_CANVAS_SIZE (1920x1080, landscape).
 * Konten vertikal - yang lazim untuk Reels/Shorts - jadi tampil sebagai video
 * potrait di tengah kanvas landscape, dengan bilah hitam di kiri dan kanan.
 *
 * Rasio TIDAK dipaksa sama dengan video: ukuran video sering ganjil
 * (mis. 1216x2160) dan menyimpannya apa adanya membuat template yang dirancang
 * untuk 1080x1920 meleset. Yang dipilih adalah preset terdekat berdasarkan
 * orientasi.
 */

describe("canvasSizeForVideo", () => {
	test("video potrait menghasilkan kanvas potrait", () => {
		// Ukuran nyata dari batch uji.
		expect(canvasSizeForVideo({ width: 1216, height: 2160 })).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(canvasSizeForVideo({ width: 1080, height: 1920 })).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	test("video landscape menghasilkan kanvas landscape", () => {
		expect(canvasSizeForVideo({ width: 1920, height: 1080 })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(canvasSizeForVideo({ width: 3840, height: 2160 })).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	test("video hampir persegi menghasilkan kanvas persegi", () => {
		expect(canvasSizeForVideo({ width: 1080, height: 1080 })).toEqual({
			width: 1080,
			height: 1080,
		});
		// 1:1 tapi sedikit melenceng, masih dalam toleransi.
		expect(canvasSizeForVideo({ width: 1000, height: 1020 })).toEqual({
			width: 1080,
			height: 1080,
		});
	});

	test("ukuran tidak diketahui jatuh ke default landscape", () => {
		expect(canvasSizeForVideo({ width: null, height: null })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(canvasSizeForVideo({})).toEqual({ width: 1920, height: 1080 });
	});

	test("ukuran tidak masuk akal diabaikan", () => {
		expect(canvasSizeForVideo({ width: 0, height: 1080 })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(canvasSizeForVideo({ width: -100, height: 200 })).toEqual({
			width: 1920,
			height: 1080,
		});
	});
});
