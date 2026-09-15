import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clamp, sendTelegram, telegramConfigured } from "@/klip/alerts";

/**
 * Tes ini menjaga SATU janji yang paling penting dari modul alerts:
 * notifikasi Telegram tidak boleh pernah menggagalkan job.
 *
 * Kalau janji ini rusak, akibatnya berat dan senyap: publish yang sudah
 * BERHASIL ke Instagram akan dianggap gagal hanya karena pesan Telegram-nya
 * tidak terkirim - lalu job di-retry dan video ter-posting dua kali.
 */
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
const saved: Record<string, string | undefined> = {};

const TELEGRAM_MAX = 4096;

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
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

describe("sendTelegram", () => {
	test("env kosong -> no-op, bukan error", async () => {
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
		process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN_PALSU";
		process.env.TELEGRAM_CHAT_ID = "-100";
		expect(telegramConfigured()).toBe(true);
		// Jaringan sungguhan ke Telegram, ditolak 401. Yang diuji: tidak throw.
		expect(await sendTelegram("tes")).toBe(false);
	});

	test("pesan sangat panjang tetap tidak melempar", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN_PALSU";
		process.env.TELEGRAM_CHAT_ID = "-100";
		expect(await sendTelegram("x".repeat(50000))).toBe(false);
	});
});
