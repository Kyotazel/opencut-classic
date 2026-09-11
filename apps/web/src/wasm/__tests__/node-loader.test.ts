import { beforeAll, describe, expect, test } from "bun:test";
import { ensureWasmLoaded } from "@/wasm/node-loader";

/**
 * MediaTime adalah number bertanda (branded) supaya tick tak bisa dibuat
 * sembarangan di kode produksi. Di tes, yang diperiksa adalah NILAI runtime,
 * jadi brand-nya dilepas agar expect() bisa membandingkan.
 */
function num(value: number): number {
	return value as number;
}
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	roundMediaTime,
	addMediaTime,
	clampMediaTime,
	maxMediaTime,
	minMediaTime,
	subMediaTime,
	mediaTime,
} from "@/wasm";

/**
 * Membuktikan opencut-wasm bisa dipakai di Node/Bun lewat node-loader.
 *
 * Ini prasyarat worker batch (Tahap 2): worker berjalan tanpa browser, dan
 * memakai pengukuran waktu yang SAMA dengan editor - bukan reimplementasi.
 */

beforeAll(async () => {
	await ensureWasmLoaded();
});

describe("nilai acuan wasm", () => {
	test("TICKS_PER_SECOND = 120000, BUKAN 1000", () => {
		// Nilai ini tidak intuitif. Kalau seseorang menulis ulang konversi waktu
		// dengan asumsi milidetik, semua durasi jadi 120x salah.
		expect(TICKS_PER_SECOND).toBe(120000);
	});

	test("ZERO_MEDIA_TIME = 0", () => {
		expect(num(ZERO_MEDIA_TIME)).toBe(0);
	});
});

describe("konversi detik <-> tick lewat wasm", () => {
	test("nilai bulat", () => {
		expect(num(mediaTimeFromSeconds({ seconds: 1 }))).toBe(120000);
		expect(num(mediaTimeFromSeconds({ seconds: 30 }))).toBe(3600000);
		expect(num(mediaTimeFromSeconds({ seconds: 7 }))).toBe(840000);
	});

	test("bolak-balik kembali ke detik semula", () => {
		for (const s of [0, 1, 7, 30, 37]) {
			expect(num(mediaTimeToSeconds({ time: mediaTimeFromSeconds({ seconds: s }) }))).toBe(s);
		}
	});

	test("kasus nyata: video 30 dtk + ad 7 dtk = 37 dtk", () => {
		const main = mediaTimeFromSeconds({ seconds: 30 });
		const ad = mediaTimeFromSeconds({ seconds: 7 });
		const total = addMediaTime({ a: main, b: ad });
		expect(num(mediaTimeToSeconds({ time: total }))).toBe(37);
	});

	test("pecahan dibulatkan ke tick terdekat", () => {
		expect(num(mediaTimeFromSeconds({ seconds: 30.5 }))).toBe(3660000);
		const back = mediaTimeToSeconds({ time: mediaTimeFromSeconds({ seconds: 0.5 }) });
		expect(back).toBe(0.5);
	});
});

describe("aritmetika tick", () => {
	test("add/sub/max/min/clamp", () => {
		const a = mediaTime({ ticks: 120000 });
		const b = mediaTime({ ticks: 360000 });
		expect(num(addMediaTime({ a, b }))).toBe(480000);
		expect(num(subMediaTime({ a: b, b: a }))).toBe(240000);
		expect(num(maxMediaTime({ a, b }))).toBe(360000);
		expect(num(minMediaTime({ a, b }))).toBe(120000);
		expect(num(clampMediaTime({ time: mediaTime({ ticks: 999999 }), min: a, max: b }))).toBe(360000);
	});

	test("roundMediaTime membulatkan ke bilangan bulat", () => {
		expect(num(roundMediaTime({ time: 1.5 }))).toBe(2);
		expect(num(roundMediaTime({ time: -1.5 }))).toBe(-2);
	});
});

describe("loader", () => {
	test("ensureWasmLoaded idempoten", async () => {
		await ensureWasmLoaded();
		await expect(ensureWasmLoaded()).resolves.toBeUndefined();
	});
});
