/**
 * Mirror 1:1 dari rust/crates/klip/src/template_resolve.rs (sumber kebenaran).
 * Alasan sama seperti brand-map.ts: logika milik rust/, TS hanya port.
 * Jangan tambah perilaku di sini; ubah Rust dulu lalu port.
 */
export type TemplateAnchor = "start" | "main_end";

export interface TemplateLayerInput {
	anchor: TemplateAnchor;
	full: boolean;
	start: number;
	dur: number;
}

export interface ResolvedLayer {
	start: number;
	dur: number;
}

export function resolveTemplateLayer(
	layer: TemplateLayerInput,
	mainDuration: number,
): ResolvedLayer {
	if (layer.full) return { start: 0, dur: mainDuration };
	if (layer.anchor === "main_end")
		return { start: mainDuration + layer.start, dur: layer.dur };
	return { start: layer.start, dur: layer.dur };
}

export function resolveTotalDuration(
	mainDuration: number,
	layers: ResolvedLayer[],
): number {
	return layers.reduce((acc, l) => Math.max(acc, l.start + l.dur), mainDuration);
}
