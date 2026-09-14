"use client";

import { useEffect, useRef, useState } from "react";
import { createProjectFromServerVideo } from "@/klip/batch-projects";
import { pushProject } from "@/klip/sync";

/**
 * Halaman internal untuk worker (Chromium headless).
 *
 * KENAPA HALAMAN, BUKAN KODE NODE
 * Kode editor (timeline, params, wasm) dirancang untuk browser. Menirunya di
 * Node berarti dua sumber kebenaran dan risiko menyimpang diam-diam. Di sini
 * alur "buat project" dijalankan kode yang SAMA dengan yang dipakai user.
 *
 * PROTOKOL
 * Worker membuka:
 *   /internal/batch-job?ref=<opencutRef>&video=<url>&name=<nama>
 * Halaman mengerjakan, lalu menulis hasilnya ke window.__BATCH_JOB_RESULT__
 * dan worker menunggu sampai nilai itu terisi.
 *
 * Dilindungi middleware seperti halaman lain (butuh sesi login), jadi worker
 * login lebih dulu.
 */

type State =
	| { kind: "working"; step: string }
	| { kind: "done"; projectId: string }
	| { kind: "error"; message: string };

// Bentuk hasil dideklarasikan sekali saja di klip/worker/chromium.ts supaya
// halaman dan runner tidak bisa berbeda pendapat soal tipenya.

export default function BatchJobPage() {
	const [state, setState] = useState<State>({ kind: "working", step: "mulai" });
	// StrictMode menjalankan efek dua kali di dev; jaga sekali saja.
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		const params = new URLSearchParams(window.location.search);
		const ref = params.get("ref");
		const video = params.get("video");
		const name = params.get("name") ?? "clip.mp4";

		const fail = (message: string) => {
			window.__BATCH_JOB_RESULT__ = { ok: false, error: message };
			setState({ kind: "error", message });
		};

		if (!ref || !video) {
			fail("ref dan video wajib ada di query");
			return;
		}

		void (async () => {
			try {
				setState({ kind: "working", step: "mengambil video" });
				const projectId = await createProjectFromServerVideo({
					projectId: ref,
					item: {
						name,
						url: video,
						width: null,
						height: null,
						duration: null,
					},
					fetchFile: async (url) => {
						const res = await fetch(url);
						if (!res.ok) throw new Error(`ambil video gagal: HTTP ${res.status}`);
						const blob = await res.blob();
						const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
						const type =
							blob.type ||
							(ext === ".mov" ? "video/quicktime" : `video/${ext.slice(1)}`);
						return new File([blob], name, { type });
					},
				});

				setState({ kind: "working", step: "menyimpan ke server" });
				await pushProject({ id: projectId });

				window.__BATCH_JOB_RESULT__ = { ok: true, projectId };
				setState({ kind: "done", projectId });
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		})();
	}, []);

	return (
		<div style={{ padding: 24, fontFamily: "monospace" }}>
			<h1 style={{ fontSize: 16 }}>Batch job</h1>
			{state.kind === "working" && (
				<p data-testid="status">bekerja: {state.step}</p>
			)}
			{state.kind === "done" && (
				<p data-testid="status">selesai: {state.projectId}</p>
			)}
			{state.kind === "error" && (
				<p data-testid="status" style={{ color: "crimson" }}>
					gagal: {state.message}
				</p>
			)}
		</div>
	);
}
