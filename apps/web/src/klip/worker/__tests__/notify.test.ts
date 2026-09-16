import { describe, expect, test } from "bun:test";
import {
	alasanManusiawi,
	nomorDariEntri,
	pesanBatchDihentikan,
	pesanBatchDiterima,
	pesanHasilAkhir,
	pesanMulaiMemproses,
} from "@/klip/worker/notify";

/**
 * Tes ini menjaga bentuk pesan Telegram: bahasa manusia, tidak bocor detail
 * teknis, dan tetap muat di batas 4096 karakter Telegram walau klipnya banyak.
 */

describe("nomorDariEntri", () => {
	test("membaca nomor dari nama entri", () => {
		expect(nomorDariEntri("clip_01_a.mp4")).toBe(1);
		expect(nomorDariEntri("clip_12_b.mp4")).toBe(12);
	});
	test("null kalau tidak berpola", () => {
		expect(nomorDariEntri("video.mp4")).toBeNull();
	});
});

describe("alasanManusiawi", () => {
	test("menerjemahkan error teknis jadi kalimat yang bisa ditindak", () => {
		expect(alasanManusiawi("video terlalu pendek")).toContain("terlalu pendek");
		expect(alasanManusiawi("Instagram API rate limit hampir habis")).toContain("batas laju");
		expect(alasanManusiawi("connect ECONNREFUSED 127.0.0.1:3000")).toContain("tidak menjawab");
	});

	test("tidak meneruskan seluruh jejak tumpukan", () => {
		// Satu baris pertama sudah memuat sebabnya; sisanya hanya membuat pesan
		// panjang dan tidak terbaca di Telegram.
		const panjang = "gagal render\nbaris 2\nbaris 3\nbaris 4";
		expect(alasanManusiawi(panjang)).not.toContain("baris 2");
	});

	test("aman untuk nilai kosong", () => {
		expect(alasanManusiawi(null)).toBe("sebab tidak diketahui");
		expect(alasanManusiawi("")).toBe("sebab tidak diketahui");
	});
});

describe("pesanHasilAkhir", () => {
	const hasil = [
		{
			nomor: 1,
			judul: "Kalau Lo Bingung",
			status: "published" as const,
			permalink: "https://www.instagram.com/reel/AAA111/",
		},
		{
			nomor: 2,
			judul: "Tiga Langkah",
			status: "published" as const,
			permalink: "https://www.instagram.com/reel/BBB222/",
		},
		{ nomor: 3, judul: "Jangan Lakukan", status: "failed" as const, alasan: "video terlalu pendek" },
	];

	test("merangkum sukses dan gagal", () => {
		const p = pesanHasilAkhir({ judul: "Cara Bikin Konten", hasil, akun: "motivasikaya26" });
		expect(p).toContain("2 tayang");
		expect(p).toContain("1 gagal");
		expect(p).toContain("\u2713 01");
		expect(p).toContain("\u2717 03");
		expect(p).toContain("video terlalu pendek");
	});

	test("tautan Reel per klip, bukan nama berkas", () => {
		// Nama berkas tidak bisa diklik dan tidak memberi tahu apa pun setelah
		// tayang; yang dicari pemiliknya justru "yang mana yang sudah naik".
		const p = pesanHasilAkhir({ judul: "x", hasil, akun: "@motivasikaya26" });
		expect(p).toContain("https://www.instagram.com/reel/AAA111/");
		expect(p).toContain("https://www.instagram.com/reel/BBB222/");
		expect(p).not.toContain("Kalau Lo Bingung");
		expect(p).toContain("instagram.com/motivasikaya26");
	});

	test("klip tayang tanpa permalink tidak mencetak baris kosong", () => {
		// IG kadang tidak mengembalikan permalink. Lebih baik "tayang" saja
		// daripada baris yang menggantung tanpa isi.
		const p = pesanHasilAkhir({
			judul: "x",
			hasil: [{ nomor: 1, judul: "a", status: "published" as const }],
		});
		expect(p).toContain("\u2713 01 tayang");
	});

	test("semua gagal -> ditandai GAGAL TOTAL", () => {
		const p = pesanHasilAkhir({
			judul: "x",
			hasil: [{ nomor: 1, judul: "a", status: "failed", alasan: "gagal render" }],
		});
		expect(p).toContain("GAGAL TOTAL");
		expect(p).not.toContain("\u2705");
	});

	test("urut berdasarkan nomor, bukan urutan kedatangan", () => {
		// Tanpa pengurutan, klip 10 bisa muncul sebelum klip 2 dan daftarnya
		// jadi sulit dibaca.
		const acak = [
			{ nomor: 10, judul: "sepuluh", status: "published" as const },
			{ nomor: 2, judul: "dua", status: "published" as const },
		];
		const p = pesanHasilAkhir({ judul: "x", hasil: acak });
		expect(p.indexOf("\u2713 02")).toBeLessThan(p.indexOf("\u2713 10"));
	});

	test("12 klip tetap di bawah batas 4096 Telegram", () => {
		// Batas anggaran: 12 klip adalah langit-langit pipeline, dan judul
		// panjang adalah kasus terburuknya.
		const banyak = Array.from({ length: 12 }, (_, i) => ({
			nomor: i + 1,
			judul: "Kalau Lo Masih Bingung Sama Hidup, Tonton Ini Sampai Habis",
			status: "published" as const,
		}));
		const p = pesanHasilAkhir({ judul: "Judul Sumber Yang Cukup Panjang Sekali", hasil: banyak, akun: "motivasikaya26" });
		expect(p.length).toBeLessThan(4096);
	});
});

describe("pesan lain", () => {
	test("batch diterima menyebut jumlah dan sumber", () => {
		const p = pesanBatchDiterima({ jobCount: 6, sumber: "OpenShorts", sudahAda: 0 });
		expect(p).toContain("6 video");
		expect(p).toContain("OpenShorts");
	});

	test("batch diterima menyebut yang dilewati kalau ada", () => {
		const p = pesanBatchDiterima({ jobCount: 2, sudahAda: 3 });
		expect(p).toContain("3 lainnya");
	});

	test("mulai memproses menyebut template kalau ada", () => {
		expect(pesanMulaiMemproses({ jobCount: 4, template: "hope well" })).toContain("hope well");
		expect(pesanMulaiMemproses({ jobCount: 4 })).not.toContain("template");
	});

	test("batch dihentikan menjelaskan sebab dan akibat", () => {
		const p = pesanBatchDihentikan({
			judul: "Cara Bikin Konten",
			sebab: "2 video gagal berturut-turut",
			sukses: 1,
			batal: 4,
		});
		expect(p).toContain("DIHENTIKAN");
		expect(p).toContain("Dibatalkan: 4");
		expect(p).toContain("jalankan ulang");
	});
});
