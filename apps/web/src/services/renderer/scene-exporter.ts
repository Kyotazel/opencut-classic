import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

/**
 * Bungkus kegagalan dengan keterangan tahap, nomor frame, dan detiknya.
 *
 * Penyebab aslinya dibawa lewat `cause`, jadi stack-nya tetap ada - sedangkan
 * pesannya sekarang menjawab "di mana", bukan cuma "apa".
 */
function petakanKegagalan({
	error,
	tahap,
	frame,
	detik,
	totalFrame,
}: {
	error: unknown;
	tahap: string;
	frame: number | null;
	detik: number | null;
	totalFrame: number;
}): Error {
	const asli = error instanceof Error ? error.message : String(error);
	const posisi =
		frame === null
			? ""
			: ` (frame ${frame}/${totalFrame}, detik ${(detik ?? 0).toFixed(2)})`;
	const dibungkus = new Error(`render gagal saat ${tahap}${posisi}: ${asli}`, {
		cause: error,
	});
	if (error instanceof Error && error.stack) {
		dibungkus.stack = `${dibungkus.stack ?? ""}\n--- dari ${tahap} ---\n${error.stack}`;
	}
	return dibungkus;
}

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			try {
				await audioSource.add(this.audioBuffer);
				audioSource.close();
			} catch (error) {
				throw petakanKegagalan({
					error,
					tahap: "menyandikan audio",
					frame: null,
					detik: null,
					totalFrame: frameCount,
				});
			}
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			// Kegagalan dipetakan per operasi dan per frame.
			//
			// KENAPA: kegagalan di sini muncul sebagai pesan generik dari
			// browser ("network error") tanpa stack dan tanpa petunjuk bagian
			// mana yang rusak. Sebelum ini satu-satunya cara menebak adalah
			// menjalankan ulang render 12 menit berulang kali.
			try {
				await this.renderer.render({ node: rootNode, time: timeTicks });
			} catch (error) {
				throw petakanKegagalan({
					error,
					tahap: "menggambar frame",
					frame: i,
					detik: timeSeconds,
					totalFrame: frameCount,
				});
			}
			try {
				await videoSource.add(timeSeconds, 1 / fpsFloat);
			} catch (error) {
				throw petakanKegagalan({
					error,
					tahap: "menyandikan frame",
					frame: i,
					detik: timeSeconds,
					totalFrame: frameCount,
				});
			}

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		try {
			await output.finalize();
		} catch (error) {
			throw petakanKegagalan({
				error,
				tahap: "menutup berkas",
				frame: null,
				detik: null,
				totalFrame: frameCount,
			});
		}
		this.emit("progress", 1);

		const buffer = output.target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", buffer);
		return buffer;
	}
}
