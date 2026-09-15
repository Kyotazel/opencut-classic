/**
 * Tes koneksi Telegram.
 *
 * KENAPA ADA: key yang salah baru ketahuan saat batch asli jalan - dan itu
 * berarti menunggu belasan menit render dulu. Perintah ini memastikan
 * token dan chat_id benar SEBELUM ada pekerjaan yang dipertaruhkan.
 *
 * PAKAI:
 *   bun run klip:telegram-test           # kirim pesan tes
 *   bun run klip:telegram-test --status  # cek konfigurasi saja
 */
import { telegramConfigured, sendTelegram } from "@/klip/alerts";

async function main(): Promise<void> {
	const statusOnly = process.argv.includes("--status");
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
	const chat = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";

	console.log("TELEGRAM_BOT_TOKEN :", token ? `terisi (${token.length} karakter)` : "KOSONG");
	console.log("TELEGRAM_CHAT_ID   :", chat || "KOSONG");
	console.log("terkonfigurasi     :", telegramConfigured());

	if (!telegramConfigured()) {
		console.log("\nBelum dikonfigurasi. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID");
		console.log("di apps/web/.env.local, lalu jalankan lagi.");
		console.log("\nCatatan: ini BUKAN error - aplikasi tetap jalan tanpa Telegram.");
		process.exit(0);
	}
	if (statusOnly) return;

	const ok = await sendTelegram("Tes koneksi berhasil \u2705");
	console.log(ok ? "\n\u2705 Terkirim - cek Telegram." : "\n\u274C Gagal kirim - lihat pesan warning di atas.");
	process.exit(ok ? 0 : 1);
}

main();
