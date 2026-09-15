import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifikasi tanda tangan ZIP dari OpenShorts.
 *
 * KENAPA ADA: /api/klip/batches menerima ZIP dan MEMPUBLISH-nya ke Instagram.
 * Tanpa pemeriksaan, siapa pun yang tahu URL-nya bisa menyuruh server ini
 * mengunggah video apa pun ke akun publik - dan tidak ada yang bisa
 * dibatalkan setelah tayang.
 *
 * Tanda tangan menutupi BYTE FILE ZIP, bukan amplop multipart-nya. Itu
 * disengaja oleh pengirim: httpx memilih boundary acak untuk setiap request,
 * jadi menandatangani amplop akan menghasilkan hash berbeda pada setiap
 * percobaan ulang dan tidak ada penerima yang bisa memverifikasinya.
 *
 * Format header: "sha256=<hex>", sama seperti yang ditulis
 * automation_delivery.post_zip() di OpenShorts.
 */

export const SIGNATURE_HEADER = "x-openshorts-signature";

/**
 * Secret dari env. Kosong berarti fitur ini MATI.
 *
 * Sengaja tidak pernah melempar: deployment yang belum mengisi secret harus
 * tetap bisa menerima ZIP lokal (uji manual, unggah dari UI) daripada
 * menolak semua permintaan.
 */
function secret(): string {
	return process.env.KLIP_WEBHOOK_SECRET?.trim() ?? "";
}

export function signatureRequired(): boolean {
	return secret().length > 0;
}

/** HMAC-SHA256 heksadesimal dari byte ZIP. */
export function signBody(body: Buffer, key: string): string {
	return createHmac("sha256", key).update(body).digest("hex");
}

/**
 * Apakah header tanda tangan cocok dengan byte ZIP?
 *
 * Selalu mengembalikan boolean dan tidak pernah melempar - pemanggil yang
 * memutuskan status HTTP-nya, supaya pesan kesalahan bisa dibedakan antara
 * "tidak ada tanda tangan" dan "tanda tangan salah".
 */
export function signatureMatches({
	body,
	header,
}: {
	body: Buffer;
	header: string | null;
}): boolean {
	const key = secret();
	if (!key) return true;
	if (!header) return false;
	const sent = header.trim().replace(/^sha256=/i, "");
	// Panjang hex SHA-256 selalu 64. Membandingkan panjang lebih dulu
	// menghindari timingSafeEqual melempar pada buffer yang panjangnya beda.
	if (!/^[0-9a-f]{64}$/i.test(sent)) return false;
	const expected = signBody(body, key);
	return timingSafeEqual(
		Buffer.from(sent.toLowerCase(), "hex"),
		Buffer.from(expected, "hex"),
	);
}
