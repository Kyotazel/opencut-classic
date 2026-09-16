/**
 * Isi pesan notifikasi batch, dipisah dari pengirimnya supaya bisa diuji
 * tanpa jaringan dan tanpa database.
 *
 * ATURAN YANG DIPAKAI DI SEMUA PESAN:
 *   - Bahasa manusia, bukan dump log. "5 video tayang di Instagram" jauh lebih
 *     berguna daripada "status=published count=5".
 *   - Sebut akibatnya, bukan cuma kejadiannya. Pembaca harus tahu apakah ia
 *     perlu bertindak.
 *   - Maksimal 10 pesan per video YouTube. Karena itu per-video TIDAK dikirim
 *     satu-satu, melainkan dirangkum di pesan hasil akhir.
 */

export type HasilKlip = {
	nomor: number;
	judul: string;
	status: "published" | "failed";
	alasan?: string;
	permalink?: string | null;
};

export function nomorDariEntri(entryName: string): number | null {
	const base = entryName.split("/").pop() ?? entryName;
	const m = /^clip_(\d{1,3})_/i.exec(base);
	if (!m) return null;
	const n = Number.parseInt(m[1] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Ubah alasan teknis menjadi kalimat yang bisa ditindaklanjuti.
 *
 * Dipakai supaya pembaca tahu apakah masalahnya bisa ia perbaiki. Kode error
 * mentah tidak memberi tahu apa-apa pada jam 6 pagi.
 */
export function alasanManusiawi(error: string | null | undefined): string {
	const e = (error ?? "").toLowerCase();
	if (!e) return "sebab tidak diketahui";
	if (e.includes("terlalu pendek") || e.includes("too short")) {
		return "video terlalu pendek untuk Instagram Reels";
	}
	if (e.includes("rate limit") || e.includes("kuota")) {
		return "batas laju Instagram tercapai - akan dicoba lagi nanti";
	}
	if (e.includes("akun ig") || e.includes("ig_account")) {
		return "akun Instagram tujuan tidak ditemukan atau tidak aktif";
	}
	if (e.includes("econnrefused") || e.includes("timeout") || e.includes("timed out")) {
		return "server tidak menjawab - periksa apakah aplikasi masih jalan";
	}
	if (e.includes("render")) return "gagal merender video";
	if (e.includes("login") || e.includes("401")) {
		return "gagal login ke aplikasi - periksa APP_USER dan APP_PASSWORD";
	}
	return (error ?? "").split("\n")[0]?.slice(0, 120) || "sebab tidak diketahui";
}

export function pesanBatchDiterima({
	jobCount,
	sumber,
	sudahAda,
}: {
	jobCount: number;
	sumber?: string | null;
	sudahAda: number;
}): string {
	const baris = [`📥 Batch diterima`, "", `${jobCount} video dari ${sumber || "OpenShorts"}`];
	if (sudahAda > 0) {
		baris.push(`${sudahAda} lainnya sudah pernah diproses - dilewati`);
	}
	baris.push("", "Diproses sekarang.");
	return baris.join("\n");
}

export function pesanMulaiMemproses({
	jobCount,
	template,
}: {
	jobCount: number;
	template?: string | null;
}): string {
	return [
		"▶️ Mulai memproses",
		"",
		`${jobCount} video${template ? ` · template "${template}"` : ""}`,
		"Render dulu, lalu publish ke Instagram.",
	].join("\n");
}

export function pesanHasilAkhir({
	judul,
	hasil,
	akun,
}: {
	judul: string;
	hasil: HasilKlip[];
	akun?: string | null;
}): string {
	const sukses = hasil.filter((h) => h.status === "published");
	const gagal = hasil.filter((h) => h.status === "failed");
	const total = hasil.length;

	const baris: string[] = [];
	if (sukses.length === 0 && gagal.length > 0) {
		baris.push("❌ GAGAL TOTAL");
	} else {
		baris.push(`✅ Hasil akhir — ${total} video`);
	}
	if (judul) baris.push(`"${judul}"`);
	baris.push("");

	const urut = [...hasil].sort((a, b) => a.nomor - b.nomor);
	for (const h of urut) {
		const no = String(h.nomor).padStart(2, "0");
		if (h.status === "published") {
			// Link Reel, bukan nama berkas. Nama berkas tidak bisa diklik dan
			// tidak memberi tahu apa pun setelah klipnya tayang - yang dicari
			// pemiliknya justru "yang mana yang sudah naik".
			baris.push(h.permalink ? `✓ ${no} ${h.permalink}` : `✓ ${no} tayang`);
		} else {
			baris.push(`✗ ${no} ${h.judul}${h.alasan ? ` — ${h.alasan}` : ""}`);
		}
	}

	baris.push("");
	const ringkas = [`${sukses.length} tayang`];
	if (gagal.length > 0) ringkas.push(`${gagal.length} gagal`);
	baris.push(ringkas.join(" · "));
	if (akun) baris.push(`Lihat: instagram.com/${akun.replace(/^@/, "")}`);
	return baris.join("\n");
}

export function pesanBatchDihentikan({
	judul,
	sebab,
	sukses,
	batal,
}: {
	judul: string;
	sebab: string;
	sukses: number;
	batal: number;
}): string {
	return [
		"⚠️ BATCH DIHENTIKAN",
		"",
		judul ? `"${judul}"` : "",
		"",
		sebab,
		"",
		`Sudah tayang: ${sukses}`,
		`Dibatalkan: ${batal}`,
		"",
		"Perbaiki penyebabnya, lalu jalankan ulang batch.",
	].filter((b) => b !== "").join("\n");
}
