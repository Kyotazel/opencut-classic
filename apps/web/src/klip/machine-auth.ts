/**
 * Aturan: kapan permintaan mesin (OpenShorts) boleh melewati login dashboard?
 *
 * KENAPA DIPISAH DARI MIDDLEWARE: middleware berjalan di Edge dan sulit diuji.
 * Aturan keamanannya sendiri sebaiknya fungsi murni supaya bisa diuji langsung -
 * terutama SYARAT WAJIB-nya, yang kalau salah membuat endpoint terbuka umum.
 */

/** Nama header yang dipakai OpenShorts untuk menandatangani ZIP. */
export const SIGNATURE_HEADER = "x-openshorts-signature";

/** Endpoint yang menerima pengiriman mesin. Selain ini wajib login. */
export const MACHINE_PATH = "/api/klip/batches";

/**
 * Boleh melewati login tanpa cookie?
 *
 * HANYA kalau KETIGANYA benar:
 *   1. path-nya endpoint pengiriman (endpoint lain tetap wajib login),
 *   2. secret terpasang,
 *   3. header tanda tangan ada.
 *
 * SYARAT 2 TIDAK BOLEH DIHAPUS. Tanpa secret, verifikasi tanda tangan mati dan
 * signatureMatches() mengembalikan true untuk apa pun - sehingga siapa saja
 * cukup mengirim header kosong untuk melewati login sepenuhnya.
 *
 * Yang diperiksa di sini hanya KEBERADAAN header, bukan keabsahannya: HMAC
 * menutupi isi berkas, dan body baru tersedia di route (middleware Edge tidak
 * punya body). Route memverifikasi ulang dan menolak 401 kalau salah.
 */
export function bolehLewatLogin({
	pathname,
	header,
	secret,
}: {
	pathname: string;
	header: string | null;
	secret: string | undefined;
}): boolean {
	if (pathname !== MACHINE_PATH) return false;
	if (!secret?.trim()) return false;
	return Boolean(header);
}
