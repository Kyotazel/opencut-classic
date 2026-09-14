/**
 * Titik masuk worker batch (Tahap 2).
 *
 * Worker TIDAK meniru logika editor di Node. Ia mengorkestrasi:
 *   ambil job -> ekstrak ZIP -> suruh Chromium membuat project via
 *   /internal/batch-job -> tempel template -> tandai rendered.
 *
 * Chromium dipakai karena kode editor (timeline, params, wasm) dirancang untuk
 * browser. Menirunya di Node sudah dicoba dan gagal: nilai waktu salah, SSR
 * rusak, dan risiko menyimpang diam-diam.
 *
 * Dijalankan pm2 sebagai proses terpisah:
 *   bun run worker                                      (dev)
 *   pm2 start ecosystem.config.cjs --only klip-worker   (produksi)
 */

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		console.log(`[worker] menerima ${signal}, berhenti...`);
		controller.abort();
	});
}

function requireEnv({ name }: { name: string }): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} wajib diisi untuk worker`);
	return value;
}

async function main() {
	// URL internal: worker memanggil aplikasi lewat HTTP, jadi harus menunjuk
	// ke server yang benar-benar melayani halaman itu.
	const baseUrl =
		process.env.KLIP_WORKER_BASE_URL?.trim() || "http://127.0.0.1:6050";
	const username = requireEnv({ name: "APP_USER" });
	const password = requireEnv({ name: "APP_PASSWORD" });
	// Tiga mode:
	//   --once   satu job, lalu berhenti
	//   --drain  kerjakan semua yang siap, lalu berhenti
	//   (tanpa flag) loop terus, menunggu job baru
	const once = process.argv.includes("--once");
	const drain = process.argv.includes("--drain");
	if (once && drain) {
		throw new Error("pilih salah satu: --once atau --drain");
	}

	// --now = tuas "jalankan sekarang": paksa kerja walau di luar window.
	// Setelan allow_manual_run bisa melarangnya; kalau dilarang, lebih baik
	// berhenti dengan pesan jelas daripada diam-diam mengabaikan window.
	let forceNow = process.argv.includes("--now");
	if (forceNow) {
		const { resolveBatchSettings } = await import("@/klip/settings");
		const settings = await resolveBatchSettings();
		if (!settings.allowManualRun) {
			throw new Error(
				"--now ditolak: setelan allow_manual_run sedang mati. " +
					"Aktifkan dulu kalau memang ingin menjalankan di luar window.",
			);
		}
		if (!settings.windowEnabled) {
			// Tidak ada window yang dilanggar; perlakukan sebagai jalan biasa.
			forceNow = false;
		}
	}

	// Peringatan dini: publish ke Instagram butuh domain PUBLIK, karena server
	// Meta yang mengunduh MP4-nya. Kalau URL-nya kosong atau menunjuk localhost,
	// setiap video akan gagal di tahap publish - dan pesan dari Meta tidak
	// menjelaskan sebabnya. Lebih baik diberitahu sekarang.
	const { resolveBatchSettings } = await import("@/klip/settings");
	const settings = await resolveBatchSettings();
	if (settings.defaultIgAccountId) {
		const base = (process.env.KLIP_PUBLIC_BASE_URL ?? "").trim();
		if (!base) {
			console.warn(
				"[worker] PERINGATAN: publish IG aktif tapi KLIP_PUBLIC_BASE_URL kosong. " +
					"Instagram butuh URL publik untuk mengunduh video, jadi publish akan gagal.",
			);
		} else if (/localhost|127\.0\.0\.1/.test(base)) {
			console.warn(
				`[worker] PERINGATAN: KLIP_PUBLIC_BASE_URL menunjuk ${base} - itu tidak bisa diunduh dari internet, jadi Instagram akan gagal memproses video.`,
			);
		}
	}

	const { runWorker } = await import("@/klip/worker/loop");
	await runWorker({
		signal: controller.signal,
		once,
		drain,
		forceNow,
		baseUrl,
		username,
		password,
	});
	process.exit(0);
}

main().catch((error: unknown) => {
	console.error("[worker] fatal:", error);
	process.exit(1);
});
