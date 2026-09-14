/**
 * Konfigurasi pm2 untuk produksi (server `third`).
 *
 * Dua proses:
 *   clip-opencut - aplikasi Next.js (port 6050)
 *   klip-worker  - worker batch (Chromium headless)
 *
 * CARA PAKAI
 *   pm2 startOrReload ecosystem.config.cjs
 *   pm2 save
 *
 * Worker memanggil aplikasi lewat HTTP (KLIP_WORKER_BASE_URL), jadi web harus
 * hidup lebih dulu. pm2 tidak menjamin urutan, tapi worker akan gagal lalu
 * dicoba lagi otomatis - jadi tidak perlu wait_ready.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

/**
 * Cari .env.production di tempat yang mungkin.
 *
 * `apps/web/.env.production` adalah lokasi yang BENAR: itu juga tempat Next.js
 * membacanya saat `next build`, jadi hanya ada satu berkas dan tidak ada
 * rahasia yang digandakan. Lokasi root dipertahankan sebagai cadangan untuk
 * pemasangan lama.
 *
 * SEJARAH: versi sebelumnya hanya membaca root, sementara server menyimpan
 * berkasnya di apps/web - akibatnya env kosong dan aplikasi gagal start.
 */
function findEnvFile() {
	for (const rel of ["apps/web/.env.production", ".env.production"]) {
		const candidate = path.join(ROOT, rel);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/** Baca .env.production sederhana (KEY=VALUE, tanpa ekspansi). */
function readEnv() {
	const file = findEnvFile();
	if (!file) {
		console.error(
			"[ecosystem] PERINGATAN: .env.production tidak ditemukan di apps/web maupun root. " +
				"Aplikasi akan start tanpa DATABASE_URL dan gagal.",
		);
		return {};
	}
	try {
		return Object.fromEntries(
			fs
				.readFileSync(file, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"))
				.map((line) => {
					const eq = line.indexOf("=");
					if (eq < 0) return [line, ""];
					const key = line.slice(0, eq).trim();
					let value = line.slice(eq + 1).trim();
					if (
						(value.startsWith('"') && value.endsWith('"')) ||
						(value.startsWith("'") && value.endsWith("'"))
					) {
						value = value.slice(1, -1);
					}
					return [key, value];
				})
				.filter(([key]) => key),
		);
	} catch {
		return {};
	}
}

const env = readEnv();

module.exports = {
	apps: [
		{
			name: "clip-opencut",
			cwd: path.join(ROOT, "apps/web"),
			script: ".next/standalone/apps/web/server.js",
			interpreter: "bun",
			env: { ...env, NODE_ENV: "production", PORT: "6050", HOSTNAME: "127.0.0.1" },
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			// Batas ini berlaku untuk server web saja. Worker TIDAK dibatasi:
			// Chromium memang memakai memori jauh lebih besar, dan mematikannya
			// di tengah render berarti pekerjaan yang sudah lama jadi sia-sia.
			max_memory_restart: "1G",
			merge_logs: true,
			time: true,
		},
		{
			name: "klip-worker",
			cwd: path.join(ROOT, "apps/web"),
			script: "worker.ts",
			interpreter: "bun",
			env: {
				...env,
				NODE_ENV: "production",
				// Worker memanggil aplikasi lewat HTTP, bukan langsung ke fungsi.
				KLIP_WORKER_BASE_URL: env.KLIP_WORKER_BASE_URL || "http://127.0.0.1:6050",
			},
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			// Worker memuat Chromium; restart berulang saat crash cepat bisa
			// menghabiskan RAM, jadi beri jeda sebelum mencoba lagi.
			restart_delay: 10000,
			max_restarts: 20,
			merge_logs: true,
			time: true,
		},
	],
};
