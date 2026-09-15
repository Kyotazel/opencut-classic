import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	SIGNATURE_HEADER,
	signBody,
	signatureMatches,
	signatureRequired,
} from "@/klip/webhook-signature";

/**
 * Tes ini menjaga satu-satunya hal yang menghalangi orang lain menyuruh
 * server ini mengunggah video sembarang ke akun Instagram publik:
 * pemeriksaan tanda tangan pada byte ZIP.
 */

const KEY = "rahasia-uji-123";
const BODY = Buffer.from("isi zip palsu untuk uji");

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved.KLIP_WEBHOOK_SECRET = process.env.KLIP_WEBHOOK_SECRET;
});

afterEach(() => {
	if (saved.KLIP_WEBHOOK_SECRET === undefined) delete process.env.KLIP_WEBHOOK_SECRET;
	else process.env.KLIP_WEBHOOK_SECRET = saved.KLIP_WEBHOOK_SECRET;
});

describe("tanpa secret", () => {
	test("fitur mati: signatureRequired() false", () => {
		delete process.env.KLIP_WEBHOOK_SECRET;
		expect(signatureRequired()).toBe(false);
	});

	test("permintaan tanpa tanda tangan tetap lolos", () => {
		// Ini yang menjaga unggahan dari UI dan uji manual tidak ikut rusak
		// saat secret belum dipasang.
		delete process.env.KLIP_WEBHOOK_SECRET;
		expect(signatureMatches({ body: BODY, header: null })).toBe(true);
	});
});

describe("dengan secret", () => {
	beforeEach(() => {
		process.env.KLIP_WEBHOOK_SECRET = KEY;
	});

	test("tanda tangan benar diterima", () => {
		const sig = "sha256=" + signBody(BODY, KEY);
		expect(signatureMatches({ body: BODY, header: sig })).toBe(true);
	});

	test("huruf besar dan tanpa prefiks juga diterima", () => {
		const hex = signBody(BODY, KEY);
		expect(signatureMatches({ body: BODY, header: hex.toUpperCase() })).toBe(true);
		expect(signatureMatches({ body: BODY, header: hex })).toBe(true);
	});

	test("TANPA tanda tangan ditolak", () => {
		expect(signatureMatches({ body: BODY, header: null })).toBe(false);
	});

	test("tanda tangan salah ditolak", () => {
		const sig = "sha256=" + signBody(BODY, "secret-yang-salah");
		expect(signatureMatches({ body: BODY, header: sig })).toBe(false);
	});

	test("INI YANG PENTING: isi diubah setelah ditandatangani -> ditolak", () => {
		// Serangan sesungguhnya: penyerang menyimpan tanda tangan yang sah
		// lalu menukar isi ZIP-nya dengan video lain.
		const sig = "sha256=" + signBody(BODY, KEY);
		const lain = Buffer.from("zip yang berbeda sama sekali");
		expect(signatureMatches({ body: lain, header: sig })).toBe(false);
	});

	test("tanda tangan cacat ditolak tanpa melempar", () => {
		// timingSafeEqual MELEMPAR kalau panjang buffer berbeda, jadi panjang
		// harus diperiksa lebih dulu - kalau tidak, permintaan cacat akan
		// menghasilkan 500 alih-alih 401.
		for (const bad of ["", "sha256=", "sha256=abc", "bukan-hex", "x".repeat(64)]) {
			expect(signatureMatches({ body: BODY, header: bad })).toBe(false);
		}
	});

	test("cocok dengan tanda tangan Python OpenShorts (uji silang nyata)", () => {
		// Nilai di bawah dihitung dengan Python, memakai kontrak yang sama persis
		// dengan sign_file() di automation_delivery.py:
		//
		//   hmac.new(b"rahasia-uji-123", b"isi zip palsu untuk uji",
		//            hashlib.sha256).hexdigest()
		//
		// Kalau tes ini gagal, artinya implementasi kita sudah menyimpang dari
		// pengirim dan SETIAP ZIP dari OpenShorts akan ditolak dengan 401.
		// Angka mati ini disengaja: menguitung ulang dengan fungsi yang sama
		// tidak membuktikan apa pun tentang kecocokan lintas bahasa.
		expect(signBody(BODY, KEY)).toBe(
			"9c2c9fe4065baba0f374351a5f239cb211cc3dbdfe5624f80538bb345a1a18b9",
		);
		expect(
			signatureMatches({
				body: BODY,
				header: "sha256=9c2c9fe4065baba0f374351a5f239cb211cc3dbdfe5624f80538bb345a1a18b9",
			}),
		).toBe(true);
	});
});
