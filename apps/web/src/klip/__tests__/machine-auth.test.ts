import { describe, expect, test } from "bun:test";
import { MACHINE_PATH, bolehLewatLogin } from "@/klip/machine-auth";

/**
 * Tes ini menjaga aturan yang membuat pengiriman otomatis bisa masuk TANPA
 * login, tanpa membuka endpoint untuk umum.
 *
 * Kalau aturan ini longgar, /api/klip/batches menerima ZIP dari siapa pun -
 * dan endpoint itu MEMPUBLISH ke Instagram publik.
 */

const HEADER = "sha256=" + "a".repeat(64);

describe("bolehLewatLogin", () => {
	test("header ada + secret terpasang + path benar -> boleh", () => {
		expect(
			bolehLewatLogin({ pathname: MACHINE_PATH, header: HEADER, secret: "rahasia" }),
		).toBe(true);
	});

	test("INI YANG PALING PENTING: tanpa secret -> TIDAK boleh", () => {
		// Tanpa syarat ini endpoint terbuka lebar: verifikasi tanda tangan mati
		// saat secret kosong, jadi siapa pun cukup mengirim header apa saja.
		for (const secret of [undefined, "", "   "]) {
			expect(bolehLewatLogin({ pathname: MACHINE_PATH, header: HEADER, secret })).toBe(
				false,
			);
		}
	});

	test("tanpa header -> tidak boleh (harus login)", () => {
		expect(
			bolehLewatLogin({ pathname: MACHINE_PATH, header: null, secret: "rahasia" }),
		).toBe(false);
	});

	test("path lain -> tidak boleh, walau header ada", () => {
		// Endpoint lain (kelola akun IG, template, project) tetap wajib login.
		for (const p of [
			"/api/klip/publishes",
			"/api/klip/ig-accounts",
			"/api/klip/brand-templates",
			"/api/klip/batches/extra",
			"/projects",
		]) {
			expect(bolehLewatLogin({ pathname: p, header: HEADER, secret: "rahasia" })).toBe(false);
		}
	});

	test("header kosong string -> tidak boleh", () => {
		expect(bolehLewatLogin({ pathname: MACHINE_PATH, header: "", secret: "rahasia" })).toBe(
			false,
		);
	});
});
