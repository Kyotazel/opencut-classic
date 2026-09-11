/**
 * Titik masuk worker batch (Tahap 2).
 *
 * Dijalankan oleh pm2 sebagai proses terpisah dari aplikasi web:
 *   bun run worker        (dev)
 *   pm2 start ecosystem.config.cjs --only klip-worker   (produksi)
 *
 * WAJIB memuat wasm lebih dulu: @/wasm dipakai oleh modul timeline, dan di
 * Node impor statisnya gagal sebelum loader sempat bekerja.
 */
import { ensureWasmLoaded } from "@/wasm/node-loader";

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		console.log(`[worker] menerima ${signal}, berhenti...`);
		controller.abort();
	});
}

async function main() {
	await ensureWasmLoaded();
	const { runWorker } = await import("@/klip/worker/loop");
	await runWorker({ signal: controller.signal });
	process.exit(0);
}

main().catch((error: unknown) => {
	console.error("[worker] fatal:", error);
	process.exit(1);
});
