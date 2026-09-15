/**
 * Notifikasi Telegram untuk proses batch.
 *
 * KENAPA ADA: proses batch berjalan tanpa manusia - worker render dan publish
 * ke Instagram sendiri. Tanpa notifikasi, satu-satunya cara tahu hasilnya
 * adalah membuka log server. Modul ini yang membuat batch "bicara".
 *
 * DUA ATURAN YANG TIDAK BOLEH DILANGGAR:
 *
 * 1. Env kosong = DIAM, bukan error. Sama seperti cloud/alerts.py di
 *    OpenShorts: kalau TELEGRAM_BOT_TOKEN belum diisi, semua fungsi di sini
 *    jadi no-op. Ini yang membuat aplikasi tetap bisa dijalankan tanpa
 *    Telegram sama sekali.
 *
 * 2. Gagal kirim TIDAK BOLEH menggagalkan job. Notifikasi itu best-effort.
 *    Publish yang sudah berhasil ke Instagram tidak boleh dianggap gagal
 *    hanya karena pesan Telegram-nya tidak terkirim.
 *
 * Prefix "KLIP" dipakai karena chat yang sama juga menerima pesan dari
 * OPENSHORTS (produk lain). Tanpa prefix, tidak jelas pesan ini dari mana.
 */

const PREFIX = "KLIP 🎬 · ";
const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

/** Batas keras Telegram. Pesan lebih panjang DITOLAK seluruhnya, bukan dipotong. */
const MAX_MESSAGE_LENGTH = 4096;

function token(): string {
	return process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
}

function chatId(): string {
	return process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
}

/** True kalau kedua env terisi. Dipakai untuk melewati kerja yang tidak perlu. */
export function telegramConfigured(): boolean {
	return Boolean(token() && chatId());
}

/**
 * Potong pesan yang kepanjangan supaya ekornya masih terkirim.
 *
 * Telegram menolak pesan > 4096 karakter SELURUHNYA - satu pesan panjang bisa
 * hilang total. Dipotong di batas baris supaya tidak memutus kalimat di tengah.
 */
export function clamp(text: string): string {
	const full = PREFIX + text;
	if (full.length <= MAX_MESSAGE_LENGTH) return full;
	const room = MAX_MESSAGE_LENGTH - PREFIX.length - 20;
	const cut = full.slice(0, room);
	const lastBreak = cut.lastIndexOf("\n");
	return (lastBreak > room * 0.6 ? cut.slice(0, lastBreak) : cut) + "\n\u2026 (dipotong)";
}

/**
 * Kirim satu pesan ke chat admin. Tidak pernah melempar.
 *
 * Mengembalikan true kalau terkirim, false kalau tidak (termasuk saat belum
 * dikonfigurasi). Pemanggil boleh mengabaikan hasilnya - itu memang tujuannya.
 */
export async function sendTelegram(text: string): Promise<boolean> {
	if (!telegramConfigured()) return false;
	try {
		const resp = await fetch(`${API_BASE}/bot${token()}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId(),
				text: clamp(text),
				disable_web_page_preview: true,
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!resp.ok) {
			// Diringkas: body error Telegram bisa memuat token di beberapa kasus.
			console.warn(`[telegram] gagal kirim: HTTP ${resp.status}`);
			return false;
		}
		return true;
	} catch (error) {
		// Termasuk timeout dan jaringan mati. Job TIDAK boleh ikut gagal.
		console.warn(
			`[telegram] gagal kirim: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}
