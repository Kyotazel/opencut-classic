"use client";

import { useEffect, useRef, useState } from "react";
import { EditorCore } from "@/core";
import { createProjectFromServerVideo } from "@/klip/batch-projects";
import { materializeBrandLayer } from "@/klip/brand-timeline";
import { pushProject } from "@/klip/sync";
import { mediaTimeToSeconds } from "@/wasm";

/**
 * Halaman internal untuk worker (Chromium headless).
 *
 * KENAPA HALAMAN, BUKAN KODE NODE
 * Kode editor (timeline, params, wasm) dirancang untuk browser. Menirunya di
 * Node berarti dua sumber kebenaran dan risiko menyimpang diam-diam. Di sini
 * seluruh alur dijalankan kode yang SAMA dengan yang dipakai user.
 *
 * PROTOKOL
 * Worker membuka:
 *   /internal/batch-job?ref=<opencutRef>&video=<url>&name=<nama>&template=<id>
 * Halaman mengerjakan lalu menulis hasilnya ke window.__BATCH_JOB_RESULT__,
 * dan worker menunggu sampai nilai itu terisi.
 */

type State =
	| { kind: "working"; step: string }
	| { kind: "done"; projectId: string }
	| { kind: "error"; message: string };

// Bentuk hasil dideklarasikan sekali di klip/worker/chromium.ts supaya
// halaman dan runner tidak bisa berbeda pendapat soal tipenya.

export default function BatchJobPage() {
	const [state, setState] = useState<State>({ kind: "working", step: "mulai" });
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		const params = new URLSearchParams(window.location.search);
		const ref = params.get("ref");
		const video = params.get("video");
		const name = params.get("name") ?? "clip.mp4";
		const templateId = params.get("template");

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
					item: { name, url: video, width: null, height: null, duration: null },
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

				if (templateId) {
					await applyTemplateToProject({ ref, projectId, name, templateId, setStep: setState });
				}

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
			{state.kind === "working" && <p data-testid="status">bekerja: {state.step}</p>}
			{state.kind === "done" && <p data-testid="status">selesai: {state.projectId}</p>}
			{state.kind === "error" && (
				<p data-testid="status" style={{ color: "crimson" }}>gagal: {state.message}</p>
			)}
		</div>
	);
}

/**
 * Tempelkan template ke project, lalu MATERIALISASIKAN ke timeline.
 *
 * Dua langkah, dan keduanya wajib:
 *   1. apply-template menulis layer ke klip_brand_layers (sumber kebenaran).
 *   2. materializeBrandLayer menyalinnya ke timeline project.
 *
 * Tanpa langkah 2, layer hanya "tercatat" - tidak terlihat di timeline dan
 * durasi project tidak bertambah, sehingga post-roll tidak ikut ter-render.
 * Langkah 2 memakai kode editor yang sama dengan tombol "Apply template" di UI.
 */
async function applyTemplateToProject({
	ref,
	projectId,
	name,
	templateId,
	setStep,
}: {
	ref: string;
	projectId: string;
	name: string;
	templateId: string;
	setStep: (state: State) => void;
}): Promise<void> {
	setStep({ kind: "working", step: "menyiapkan template" });

	// Baris klip_projects dibuat di sini kalau belum ada; worker memanggil hal
	// yang sama nanti dan operasi ini idempoten.
	const resolveRes = await fetch(
		`/api/klip/projects/by-opencut?opencutRef=${encodeURIComponent(ref)}&name=${encodeURIComponent(name)}`,
	);
	if (!resolveRes.ok) throw new Error(`resolve project gagal: ${resolveRes.status}`);
	const resolved = (await resolveRes.json()) as { project: { id: string } };

	// Muat project ke editor supaya timeline-nya bisa disunting.
	const editor = EditorCore.getInstance();
	await editor.project.loadProject({ id: projectId });
	const project = editor.project.getActiveOrNull();
	if (!project) throw new Error("project tidak aktif setelah dimuat");

	const mainDuration = mediaTimeToSeconds({
		time: project.metadata.duration ?? 0,
	});

	setStep({ kind: "working", step: "menulis layer template" });
	const applyRes = await fetch(
		`/api/klip/projects/${encodeURIComponent(resolved.project.id)}/apply-template`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ templateId, mainDuration }),
		},
	);
	if (!applyRes.ok) {
		const body = (await applyRes.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `apply-template gagal: ${applyRes.status}`);
	}
	const applied = (await applyRes.json()) as { layers: Parameters<typeof materializeBrandLayer>[0]["layer"][] };

	setStep({ kind: "working", step: "menempelkan ke timeline" });
	const canvasWidth = project.settings.canvasSize.width;
	const canvasHeight = project.settings.canvasSize.height;
	for (const layer of applied.layers) {
		await materializeBrandLayer({
			editor,
			layer,
			canvasWidth,
			canvasHeight,
			totalDuration: mainDuration,
		});
	}

	// PENTING: insertElement hanya mengubah state DI MEMORI editor, sedangkan
	// pushProject membaca dari penyimpanan browser (IndexedDB). Tanpa
	// saveCurrentProject, elemen template tidak ikut terkirim dan timeline di
	// server tetap kosong walaupun layer sudah tercatat di database.
	setStep({ kind: "working", step: "menyimpan hasil" });
	await editor.project.saveCurrentProject();
	await pushProject({ id: projectId });
}
