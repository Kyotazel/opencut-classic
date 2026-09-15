import { afterEach, describe, expect, test } from "bun:test";
import { clamp, sendTelegram, telegramConfigured } from "@/klip/alerts";

/**
 * Tes ini menjaga SATU janji yang paling penting dari modul alerts:
 * notifikasi Telegram tidak boleh pernah menggagalkan job.
 *
 * Kalau janji ini rusak, akibatnya berat dan senyap: publish yang sudah
 * BERHASIL ke Instagram akan dianggap gagal hanya karena pesan Telegram-nya
 * tidak terkirim - lalu job di-retry dan video ter-posting dua kali.
 */
const ENV_KEYS = [
	"TELEGRAM_BOT_TOKEN",
	"TELEGRAM_CHAT_ID",
	"TELEGRAM_DISABLED",
] as const;
const TELEGRAM_MAX = 4096;

/**
 * Nilai asli env, diambil SEKALI saat modul dimuat.
 *
 * KENAPA BUKAN DI beforeEach: kalau snapshot diambil sebelum tiap tes, ia
 * menyalin env yang sudah dimodifikasi tes SEBELUMNYA - sehingga satu tes yang
 * lupa membersihkan akan merembet ke semua tes berikutnya, dan kegagalannya
 * muncul di tempat yang salah. Snapshot sekali di sini membuat setiap tes
 * selalu dimulai dari keadaan asli.
 */
const ASLI: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ASLI[k] = process.env[k];

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (ASLI[k] === undefined) delete process.env[k];
		else process.env[k] = ASLI[k];
	}
});

describe("clamp", () => {
	test("pesan pendek tidak diubah", () => {
		const out = clamp("halo");
		expect(out).toBe("KLIP 🎬 · halo");
	});

	test("tidak pernah melebihi batas Telegram", () => {
		// Telegram menolak pesan > 4096 SELURUHNYA - kelebihan sedikit pun
		// berarti pesan hilang total, bukan terpotong.
		for (const n of [100, 4000, 4086, 4087, 4096, 4097, 9000, 50000]) {
			expect(clamp("x".repeat(n)).length).toBeLessThanOrEqual(TELEGRAM_MAX);
		}
	});

	test("memotong di batas baris, bukan di tengah kalimat", () => {
		const baris = Array(200).fill("baris yang cukup panjang").join("\n");
		const out = clamp(baris);
		expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX);
		expect(out).toContain("(dipotong)");
		// Baris terakhir sebelum penanda harus utuh, tidak terbelah.
		const sebelum = out.slice(0, out.lastIndexOf("\n"));
		expect(sebelum.endsWith("panjang")).toBe(true);
	});

	test("menandai bahwa pesan dipotong", () => {
		expect(clamp("x".repeat(9000))).toContain("(dipotong)");
		expect(clamp("x".repeat(10))).not.toContain("(dipotong)");
	});
});

describe("sakelar mati TELEGRAM_DISABLED", () => {
	test("token LENGKAP tapi sakelar nyala -> tidak dikonfigurasi", () => {
		// Ini yang mencegah uji-uji otomatis membanjiri chat Telegram nyata.
		// Sengaja diuji dengan token yang TERISI: kalau tokennya kosong,
		// telegramConfigured() sudah false dan tesnya tidak membuktikan apa pun.
		process.env.TELEGRAM_BOT_TOKEN = "123:token-asli-palsu";
		process.env.TELEGRAM_CHAT_ID = "-100";
		process.env.TELEGRAM_DISABLED = "1";
		expect(telegramConfigured()).toBe(false);
	});

	test("semua bentuk penulisan benar dikenali", () => {
		process.env.TELEGRAM_BOT_TOKEN = "123:token";
		process.env.TELEGRAM_CHAT_ID = "-100";
		for (const v of ["1", "true", "TRUE", "yes", "Yes", " true "]) {
			process.env.TELEGRAM_DISABLED = v;
			expect(telegramConfigured()).toBe(false);
		}
	});

	test("sakelar mati -> configure tetap true (token tetap dianggap ada)", () => {
		process.env.TELEGRAM_BOT_TOKEN = "123:token";
		process.env.TELEGRAM_CHAT_ID = "-100";
		for (const v of ["", "0", "false", "no"]) {
			process.env.TELEGRAM_DISABLED = v;
			expect(telegramConfigured()).toBe(true);
		}
	});

	test("sakelar nyala -> sendTelegram mengembalikan false tanpa menghubungi jaringan", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "123:token";
		process.env.TELEGRAM_CHAT_ID = "-100";
		process.env.TELEGRAM_DISABLED = "1";
		const mulai = Date.now();
		expect(await sendTelegram("tidak boleh terkirim")).toBe(false);
		// Tidak ada panggilan jaringan berarti selesai hampir seketika. Kalau
		// ini lambat, berarti ia benar-benar menghubungi Telegram.
		expect(Date.now() - mulai).toBeLessThan(200);
	});
});

describe("sendTelegram", () => {
	test("env kosong -> no-op, bukan error", async () => {
		delete process.env.TELEGRAM_DISABLED;
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.TELEGRAM_CHAT_ID;
		expect(telegramConfigured()).toBe(false);
		// Yang penting: TIDAK melempar, dan jujur bilang tidak terkirim.
		expect(await sendTelegram("apa saja")).toBe(false);
	});

	test("hanya satu env terisi -> tetap no-op", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "123:abc";
		delete process.env.TELEGRAM_CHAT_ID;
		expect(telegramConfigured()).toBe(false);
		expect(await sendTelegram("tes")).toBe(false);
	});

	test("token salah -> false, TIDAK melempar", async () => {
		// Sakelar dimatikan EKSPLISIT supaya tes ini benar-benar menguji jalur
		// jaringan (permintaan ke Telegram, ditolak 401) dan bukan kebetulan
		// lolos karena .env.local mematikan notifikasi.
		//
		// Tokennya sengaja palsu: tes ini TIDAK PERNAH mengirim pesan sungguhan.
		delete process.env.TELEGRAM_DISABLED;
		process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN_PALSU";
		process.env.TELEGRAM_CHAT_ID = "-100";
		expect(telegramConfigured()).toBe(true);
		// Jaringan sungguhan ke Telegram, ditolak 401. Yang diuji: tidak throw.
		expect(await sendTelegram("tes")).toBe(false);
	});

	test("pesan sangat panjang tetap tidak melempar", async () => {
		delete process.env.TELEGRAM_DISABLED;
		process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN_PALSU";
		process.env.TELEGRAM_CHAT_ID = "-100";
		expect(await sendTelegram("x".repeat(50000))).toBe(false);
	});
});
