export type ClockTime = { hour: number; minute: number };

/**
 * Apakah waktu sekarang berada di dalam window render?
 *
 * Window adalah tuas tunggal yang menyatukan tiga masalah sekaligus (T3-5):
 * beban CPU server, RAM Chromium, dan laju publish ke Instagram. Di luar
 * window, worker menunggu - job TIDAK hilang, hanya ditunda.
 *
 * Mengembalikan true kalau window tidak aktif (start/end kosong), karena
 * default-nya adalah "jalan kapan saja". Ini yang membuat upload langsung
 * dikerjakan tanpa setelan apa pun.
 *
 * Mendukung window yang melewati tengah malam (mis. 22:00-02:00).
 */
export function isWithinWindow({
	now,
	start,
	end,
}: {
	now: ClockTime;
	start: ClockTime | null;
	end: ClockTime | null;
}): boolean {
	// Tanpa batas yang valid, anggap selalu terbuka.
	if (!start || !end) return true;

	const toMinutes = ({ hour, minute }: ClockTime) => hour * 60 + minute;
	const nowMin = toMinutes(now);
	const startMin = toMinutes(start);
	const endMin = toMinutes(end);

	// Start == end dianggap 24 jam, bukan nol menit. Kalau dianggap nol menit,
	// setelan yang tampak "11:00-11:00" akan membekukan worker selamanya -
	// kegagalan yang membingungkan dan sulit dilacak.
	if (startMin === endMin) return true;

	if (startMin < endMin) {
		return nowMin >= startMin && nowMin < endMin;
	}
	// Melewati tengah malam: 22:00-02:00 berarti >= 22:00 ATAU < 02:00.
	return nowMin >= startMin || nowMin < endMin;
}

/** Menit sampai window berikutnya dibuka; 0 kalau sedang terbuka. */
export function minutesUntilWindow({
	now,
	start,
	end,
}: {
	now: ClockTime;
	start: ClockTime | null;
	end: ClockTime | null;
}): number {
	if (isWithinWindow({ now, start, end })) return 0;
	if (!start) return 0;
	const nowMin = now.hour * 60 + now.minute;
	const startMin = start.hour * 60 + start.minute;
	// Selisih dalam hari yang sama; kalau sudah lewat, tunggu sampai besok.
	return startMin > nowMin ? startMin - nowMin : 24 * 60 - nowMin + startMin;
}
