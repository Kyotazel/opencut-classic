/**
 * Baca caption per-video dari captions.json di dalam ZIP batch.
 *
 * KENAPA MODUL SENDIRI: pemetaan caption ke video itu tempat kesalahan yang
 * paling mahal di seluruh alur ini. Kalau salah pasang, video A tayang dengan
 * caption video B di akun Instagram publik - dan tidak ada yang memberi tahu.
 * Karena itu logikanya dipisah supaya bisa diuji tanpa membuat ZIP.
 *
 * KENAPA LEWAT NAMA FILE, BUKAN INDEX: captions.json memuat field "index"
 * (1, 2, 3...), tapi ekstraksi bisa MELEWATI video (path tidak aman, terlalu
 * besar, atau tidak bisa dibaca). Satu video yang dilewati menggeser seluruh
 * index sesudahnya, dan caption akan tertempel ke video yang salah - diam-diam,
 * tanpa error. Nama file tidak bisa bergeser.
 *
 * OpenShorts menamai entri ZIP "clip_01_<nama asli>.mp4" dan menulis caption
 * dengan index yang sama, jadi angka di nama file SELALU cocok dengan index.
 */

export type ClipCaption = {
	/** Caption untuk Instagram. Kosong berarti tidak ada caption. */
	instagram: string;
	/** Disimpan walau belum dipakai - publish TikTok tinggal memakainya. */
	tiktok: string;
	title: string;
	hook: string;
};

const EMPTY: ClipCaption = { instagram: "", tiktok: "", title: "", hook: "" };

/**
 * Ambil nomor klip dari nama entri ZIP: "clip_03_apapun.mp4" -> 3.
 *
 * Mengembalikan null kalau namanya tidak berpola clip_NN, supaya pemanggil
 * bisa memutuskan sendiri (dan tidak diam-diam mencocokkan yang salah).
 */
export function clipNumberFromName(name: string): number | null {
	const base = name.split("/").pop() ?? name;
	const m = /^clip_(\d{1,3})_/i.exec(base);
	if (!m) return null;
	const n = Number.parseInt(m[1] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Ubah isi captions.json menjadi peta nomor klip -> caption.
 *
 * Toleran dengan sengaja: file ini datang dari sistem lain, dan satu entri
 * cacat tidak boleh menggagalkan seluruh batch. Entri yang tidak bisa dibaca
 * dilewati, bukan melempar.
 */
export function parseCaptions(raw: string): Map<number, ClipCaption> {
	const out = new Map<number, ClipCaption>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// captions.json rusak = tidak ada caption. Batch tetap jalan: video yang
		// tidak punya caption masih bisa dipublikasikan tanpa caption.
		return out;
	}
	// Bentuk yang diharapkan: array di root. Objek dengan "captions" juga
	// diterima supaya perubahan bentuk di sisi pengirim tidak langsung merusak.
	const list = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { captions?: unknown })?.captions)
			? ((parsed as { captions: unknown[] }).captions)
			: [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const n = Number.parseInt(String(rec.index ?? ""), 10);
		if (!Number.isFinite(n) || n <= 0) continue;
		out.set(n, {
			instagram: asText(rec.instagram) || asText(rec.caption),
			tiktok: asText(rec.tiktok),
			title: asText(rec.title),
			hook: asText(rec.hook),
		});
	}
	return out;
}

/**
 * Caption untuk satu entri video, atau null kalau tidak ada.
 *
 * Dua jalur pencocokan, berurutan:
 *   1. nomor dari nama file ("clip_03_...") - cara utama
 *   2. kalau namanya tidak berpola, JANGAN menebak. Mengembalikan null lebih
 *      benar daripada memasangkan caption ke video yang belum tentu cocok.
 */
export function captionForEntry(
	entryName: string,
	captions: Map<number, ClipCaption>,
): ClipCaption | null {
	const n = clipNumberFromName(entryName);
	if (n === null) return null;
	const found = captions.get(n);
	if (!found) return null;
	// Entri yang benar-benar kosong diperlakukan sebagai "tidak ada caption",
	// supaya tidak menulis string kosong ke database.
	return found.instagram ? found : null;
}

export { EMPTY as EMPTY_CAPTION };
