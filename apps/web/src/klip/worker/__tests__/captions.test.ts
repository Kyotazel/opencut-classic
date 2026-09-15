import { describe, expect, test } from "bun:test";
import {
	captionForEntry,
	clipNumberFromName,
	parseCaptions,
} from "@/klip/worker/captions";

/**
 * Tes ini menjaga pemetaan caption -> video, tempat kesalahan paling mahal
 * di seluruh alur: salah pasang berarti video A tayang dengan caption video B
 * di akun Instagram publik, tanpa error apa pun.
 */

const CAPTIONS = JSON.stringify([
	{ index: 1, instagram: "caption satu", tiktok: "tt1", title: "judul 1", hook: "hook 1" },
	{ index: 2, instagram: "caption dua", tiktok: "tt2", title: "judul 2", hook: "hook 2" },
	{ index: 3, instagram: "", tiktok: "tt3", title: "judul 3", hook: "hook 3" },
]);

describe("clipNumberFromName", () => {
	test("membaca nomor dari nama entri OpenShorts", () => {
		expect(clipNumberFromName("clip_01_abc.mp4")).toBe(1);
		expect(clipNumberFromName("clip_12_xyz.mp4")).toBe(12);
		expect(clipNumberFromName("clip_7_a.mp4")).toBe(7);
	});

	test("mengabaikan folder di depan nama", () => {
		expect(clipNumberFromName("sub/dir/clip_03_x.mp4")).toBe(3);
	});

	test("null kalau tidak berpola clip_NN - JANGAN menebak", () => {
		// Mengembalikan null memaksa pemanggil berhenti, bukan memasangkan
		// caption ke video yang belum tentu cocok.
		expect(clipNumberFromName("video.mp4")).toBeNull();
		expect(clipNumberFromName("myclip_01_a.mp4")).toBeNull();
		expect(clipNumberFromName("clip_abc.mp4")).toBeNull();
		expect(clipNumberFromName("clip_00_a.mp4")).toBeNull(); // 0 bukan klip valid
	});
});

describe("parseCaptions", () => {
	test("membaca array di root", () => {
		const m = parseCaptions(CAPTIONS);
		expect(m.size).toBe(3);
		expect(m.get(1)?.instagram).toBe("caption satu");
		expect(m.get(2)?.tiktok).toBe("tt2");
	});

	test("menerima bentuk { captions: [...] } juga", () => {
		const m = parseCaptions(JSON.stringify({ captions: [{ index: 1, instagram: "x" }] }));
		expect(m.get(1)?.instagram).toBe("x");
	});

	test("JSON rusak -> peta kosong, TIDAK melempar", () => {
		// captions.json rusak tidak boleh menggagalkan seluruh batch.
		expect(parseCaptions("{ ini bukan json").size).toBe(0);
		expect(parseCaptions("").size).toBe(0);
	});

	test("melewati entri cacat, bukan gagal total", () => {
		const m = parseCaptions(
			JSON.stringify([
				{ index: 1, instagram: "ok" },
				null,
				"bukan objek",
				{ index: "bukan angka", instagram: "x" },
				{ instagram: "tanpa index" },
				{ index: 2, instagram: "ok juga" },
			]),
		);
		expect(m.size).toBe(2);
		expect(m.get(2)?.instagram).toBe("ok juga");
	});

	test("field caption dipakai kalau instagram kosong", () => {
		const m = parseCaptions(JSON.stringify([{ index: 1, caption: "cadangan" }]));
		expect(m.get(1)?.instagram).toBe("cadangan");
	});
	test("memangkas spasi di ujung", () => {
		const m = parseCaptions(JSON.stringify([{ index: 1, instagram: "  ada spasi  " }]));
		expect(m.get(1)?.instagram).toBe("ada spasi");
	});
});

describe("captionForEntry", () => {
	test("memasangkan lewat nomor nama file", () => {
		const m = parseCaptions(CAPTIONS);
		expect(captionForEntry("clip_01_a.mp4", m)?.instagram).toBe("caption satu");
		expect(captionForEntry("clip_02_b.mp4", m)?.instagram).toBe("caption dua");
	});

	test("INI YANG PALING PENTING: video yang dilewati tidak menggeser caption", () => {
		// Skenario nyata: clip_02 terlalu besar sehingga ekstraksi melewatinya
		// (extract.ts memang melewati file yang tidak lolos, dan mencatatnya di
		// "skipped"). Kalau caption dipasangkan lewat URUTAN, clip_03 akan
		// mendapat caption clip_02 - diam-diam, tanpa error, dan tayang di IG.
		//
		// Dengan pemasangan lewat NAMA FILE, clip_03 tetap mendapat captionnya
		// sendiri. Itu properti yang diuji di sini.
		const m = parseCaptions(CAPTIONS);
		const nomor = clipNumberFromName("clip_03_c.mp4");
		expect(nomor).toBe(3);
		// Nomor 3 -> entri index 3, BUKAN entri kedua dalam array.
		expect(m.get(nomor as number)?.title).toBe("judul 3");
		expect(m.get(nomor as number)?.tiktok).toBe("tt3");
	});

	test("entri tanpa caption -> null, bukan string kosong", () => {
		// Entri index 3 punya instagram kosong; menulis "" ke database akan
		// membuat caption kosong menimpa caption batch.
		const m = parseCaptions(CAPTIONS);
		expect(captionForEntry("clip_03_c.mp4", m)).toBeNull();
	});

	test("nama tidak berpola -> null (menyerahkan ke caption batch)", () => {
		const m = parseCaptions(CAPTIONS);
		expect(captionForEntry("video-biasa.mp4", m)).toBeNull();
	});

	test("nomor di luar daftar -> null", () => {
		const m = parseCaptions(CAPTIONS);
		expect(captionForEntry("clip_99_z.mp4", m)).toBeNull();
	});

	test("peta kosong -> null untuk apa pun", () => {
		expect(captionForEntry("clip_01_a.mp4", new Map())).toBeNull();
	});
});
