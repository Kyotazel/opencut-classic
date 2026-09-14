import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import {
	type KlipBrandLayer,
	fileExtension,
	klipLayerToElement,
} from "@/klip/brand-map";

export type MaterializedLayer = {
	elementId: string;
	trackId: string;
	assetWidth: number | null;
	assetHeight: number | null;
};

/**
 * Masukkan satu layer brand ke timeline project yang sedang terbuka.
 *
 * KENAPA DIEKSTRAK
 * Logika ini dulu hanya ada di dalam komponen BrandPanel, sehingga jalur
 * otomatis (worker) tidak bisa memakainya: worker menulis layer ke
 * klip_brand_layers, tetapi timeline project tidak ikut terisi - template
 * "tercatat" tapi tidak terlihat, dan durasi project tidak bertambah.
 * Dengan dipakai bersama, kedua jalur menghasilkan timeline yang sama.
 *
 * URUTAN PENTING: berkas brand harus didaftarkan sebagai media browser dulu.
 * Scene-builder melewati elemen yang mediaId-nya tidak dikenal, jadi kalau
 * elemen dibuat sebelum medianya terdaftar, elemen itu hilang saat render.
 */
export async function materializeBrandLayer({
	editor,
	layer,
	canvasWidth,
	canvasHeight,
	totalDuration,
}: {
	editor: EditorCore;
	layer: KlipBrandLayer;
	canvasWidth: number;
	canvasHeight: number;
	totalDuration: number;
}): Promise<MaterializedLayer> {
	const project = editor.project.getActiveOrNull();
	if (!project) throw new Error("materializeBrandLayer: tidak ada project aktif");

	// Berkas brand diambil dari server; id yang dikembalikan storage browser
	// itulah yang dipakai sebagai mediaId elemen.
	const serverId = layer.asset_id ?? layer.file;
	const fileRes = await fetch(`/api/media/${encodeURIComponent(serverId)}`);
	if (!fileRes.ok) {
		throw new Error(`Berkas brand tidak ada di server: ${serverId}`);
	}
	const blob = await fileRes.blob();
	const ext = fileExtension({ filename: layer.file });
	const file = new File([blob], `${layer.name}${ext}`, {
		type: blob.type || undefined,
	});
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("materializeBrandLayer: gagal memproses berkas");
	const saved = await editor.media.addMediaAsset({
		projectId: project.metadata.id,
		asset: processed,
	});
	if (!saved) throw new Error("materializeBrandLayer: gagal mendaftarkan media");

	const { element } = klipLayerToElement(
		{ ...layer, asset_id: saved.id, file: saved.id },
		{
			canvasWidth,
			canvasHeight,
			totalDuration,
			assetWidth: saved.width ?? undefined,
			assetHeight: saved.height ?? undefined,
		},
	);
	const mapped = { ...element, mediaId: saved.id };

	// Id elemen baru dikenali lewat selisih himpunan id sebelum/sesudah; cara ini
	// deterministik untuk satu penyisipan, tidak seperti mencocokkan nama atau
	// mediaId yang bisa kembar.
	const idsBefore = collectElementIds({ editor });
	editor.timeline.insertElement({ placement: { mode: "auto" }, element: mapped });
	const scene = editor.scenes.getActiveScene();
	for (const track of [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]) {
		const match = track.elements.find((e) => !idsBefore.has(e.id));
		if (match) {
			return {
				elementId: match.id,
				trackId: track.id,
				assetWidth: saved.width ?? null,
				assetHeight: saved.height ?? null,
			};
		}
	}
	throw new Error("materializeBrandLayer: elemen tidak ditemukan setelah insert");
}

function collectElementIds({ editor }: { editor: EditorCore }): Set<string> {
	const scene = editor.scenes.getActiveScene();
	const ids = new Set<string>();
	for (const track of [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]) {
		for (const element of track.elements) ids.add(element.id);
	}
	return ids;
}
