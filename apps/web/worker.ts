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
	const once = process.argv.includes("--once");

	const { runWorker } = await import("@/klip/worker/loop");
	await runWorker({
		signal: controller.signal,
		once,
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
