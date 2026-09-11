import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Membuktikan glue opencut-wasm bisa dipakai di Node/Bun lewat node-loader.
 *
 * CATATAN: tes ini mengimpor GLUE langsung, bukan `@/wasm`. Modul `@/wasm`
 * mengimpor pembungkus "opencut-wasm" yang memang selalu gagal di Node
 * (dibangun untuk bundler), dan itu tidak diubah - worker memakai Chromium
 * headless untuk menjalankan kode editor.
 *
 * Yang dibuktikan di sini: loader bisa mengompilasi .wasm dan menyuntikkannya,
 * sehingga nilai acuan (TICKS_PER_SECOND = 120000) bisa diverifikasi langsung
 * terhadap wasm asli - bukan terhadap tebakan.
 */

type Glue = {
	TICKS_PER_SECOND: () => number;
	mediaTimeFromSeconds: (args: { seconds: number }) => number;
	mediaTimeToSeconds: (args: { time: number }) => number;
};

let glue: Glue;

beforeAll(async () => {
	const { ensureWasmLoaded } = await import("@/wasm/node-loader");
	await ensureWasmLoaded();
	glue = (await import("opencut-wasm/opencut_wasm_bg.js")) as unknown as Glue;
});

describe("glue opencut-wasm di Node", () => {
	test("TICKS_PER_SECOND = 120000, BUKAN 1000", () => {
		// Nilai ini tidak intuitif. Kalau seseorang menulis ulang konversi waktu
		// dengan asumsi milidetik, semua durasi jadi 120x salah.
		expect(glue.TICKS_PER_SECOND()).toBe(120_000);
	});

	test("konversi detik -> tick", () => {
		expect(glue.mediaTimeFromSeconds({ seconds: 1 })).toBe(120_000);
		expect(glue.mediaTimeFromSeconds({ seconds: 30 })).toBe(3_600_000);
		expect(glue.mediaTimeFromSeconds({ seconds: 7 })).toBe(840_000);
		expect(glue.mediaTimeFromSeconds({ seconds: 30.5 })).toBe(3_660_000);
	});

	test("bolak-balik kembali ke detik semula", () => {
		for (const s of [0, 1, 7, 30, 37]) {
			const ticks = glue.mediaTimeFromSeconds({ seconds: s });
			expect(glue.mediaTimeToSeconds({ time: ticks })).toBe(s);
		}
	});

	test("kasus nyata: video 30 dtk + ad 7 dtk = 37 dtk", () => {
		const main = glue.mediaTimeFromSeconds({ seconds: 30 });
		const ad = glue.mediaTimeFromSeconds({ seconds: 7 });
		expect(glue.mediaTimeToSeconds({ time: main + ad })).toBe(37);
	});

	test("negatif membulat menjauhi nol, sama seperti Rust .round()", () => {
		expect(glue.mediaTimeFromSeconds({ seconds: -0.5 })).toBe(-60_000);
		expect(glue.mediaTimeFromSeconds({ seconds: -1.5 })).toBe(-180_000);
	});
});
