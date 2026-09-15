import { getSetting, SETTING_KEYS, setSetting } from "@/klip/settings";

/**
 * Keadaan kuota Instagram, ditulis worker dan dibaca UI.
 *
 * KENAPA DISIMPAN: kuota panggilan Instagram dihitung per 24 jam bergulir
 * sebagai `4800 * jumlah penayangan`, jadi akun testing punya kuota kecil dan
 * habisnya tidak terlihat dari mana pun. Meta melaporkan perkiraan waktu pulih
 * lewat header, dan angka itu perlu bertahan supaya UI bisa menampilkannya
 * tanpa harus menggali log.
 */
export type StatusKuotaIg = {
	/** Persentase pemakaian terakhir yang dilaporkan Meta (0-100). */
	pemakaian: number | null;
	/** Perkiraan kapan akses pulih (ISO 8601), dari Meta. */
	pulihPada: string | null;
	/** Keterangan singkat untuk ditampilkan. */
	pesan: string | null;
};

function parse({ raw }: { raw: string }): StatusKuotaIg | null {
	if (!raw.trim()) return null;
	try {
		const nilai: unknown = JSON.parse(raw);
		if (!nilai || typeof nilai !== "object") return null;
		const rec = Object.fromEntries(Object.entries(nilai));
		const angka = rec["pemakaian"];
		const pulih = rec["pulihPada"];
		const pesan = rec["pesan"];
		return {
			pemakaian:
				typeof angka === "number" && Number.isFinite(angka) ? angka : null,
			pulihPada: typeof pulih === "string" && pulih ? pulih : null,
			pesan: typeof pesan === "string" && pesan ? pesan : null,
		};
	} catch {
		// Nilai rusak diperlakukan sebagai "tidak ada catatan"; UI lebih baik
		// tidak menampilkan apa pun daripada gagal membaca.
		return null;
	}
}

export async function bacaStatusKuota(): Promise<StatusKuotaIg | null> {
	return parse({ raw: await getSetting({ key: SETTING_KEYS.igQuotaStatus }) });
}

export async function simpanStatusKuota({
	status,
}: {
	status: StatusKuotaIg;
}): Promise<void> {
	await setSetting({
		key: SETTING_KEYS.igQuotaStatus,
		value: JSON.stringify(status),
	});
}

/** Hapus catatan; dipakai setelah publish berhasil supaya peringatan hilang. */
export async function bersihkanStatusKuota(): Promise<void> {
	await setSetting({ key: SETTING_KEYS.igQuotaStatus, value: "" });
}

/**
 * Perkiraan pulih dalam bentuk teks, mis. "sekitar 45 menit lagi".
 *
 * Mengembalikan null kalau waktunya sudah lewat: peringatan yang sudah basi
 * lebih menyesatkan daripada tidak ada peringatan sama sekali.
 */
export function deskripsiPulih({
	status,
}: {
	status: StatusKuotaIg;
}): string | null {
	if (!status.pulihPada) return null;
	const pulih = new Date(status.pulihPada).getTime();
	if (!Number.isFinite(pulih)) return null;
	const sisaMenit = Math.ceil((pulih - Date.now()) / 60_000);
	if (sisaMenit <= 0) return null;
	if (sisaMenit < 60) return `sekitar ${sisaMenit} menit lagi`;
	const jam = Math.floor(sisaMenit / 60);
	const sisa = sisaMenit % 60;
	return sisa === 0
		? `sekitar ${jam} jam lagi`
		: `sekitar ${jam} jam ${sisa} menit lagi`;
}
