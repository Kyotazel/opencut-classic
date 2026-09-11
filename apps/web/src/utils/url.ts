/**
 * Bangun URL absolut untuk redirect dari sisi server.
 *
 * `request.url` di belakang reverse proxy berisi alamat internal
 * (mis. http://127.0.0.1:6050), sehingga redirect yang dibangun darinya
 * membuang user ke host internal. Selalu pakai NEXT_PUBLIC_SITE_URL
 * sebagai basis, dengan fallback ke request hanya bila env tidak ada.
 */
export function absoluteUrl({
	path,
	requestUrl,
}: {
	path: string;
	requestUrl?: string;
}): URL {
	const base = process.env.NEXT_PUBLIC_SITE_URL;
	if (base) {
		return new URL(path, base.endsWith("/") ? base : `${base}/`);
	}
	return new URL(path, requestUrl);
}
