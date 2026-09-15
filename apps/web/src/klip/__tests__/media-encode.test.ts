import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pastikanAudioAac } from "@/klip/media-encode";

/**
 * Normalisasi audio ke AAC.
 *
 * KENAPA PENTING: Chromium headless milik Playwright tidak punya encoder AAC,
 * sehingga render menghasilkan MP4 ber-audio Opus. Dua video sempat terbit ke
 * Instagram begitu, lalu yang ketiga ditolak Meta tanpa keterangan.
 */

const execFileAsync = promisify(execFile);
let dir = "";

/** Apakah ffmpeg tersedia lengkap dengan encoder yang dibutuhkan. */
async function ffmpegSiap(): Promise<boolean> {
	try {
		await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-encoders"], {
			timeout: 20_000,
		});
		return true;
	} catch {
		return false;
	}
}

async function kodekAudio({ file }: { file: string }): Promise<string> {
	const { stdout } = await execFileAsync("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"a:0",
		"-show_entries",
		"stream=codec_name",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		file,
	]);
	return stdout.trim().toLowerCase();
}

/** Video 1 detik 64x64; codec audio ditentukan pemanggil. */
async function buatUji({
	file,
	codecAudio,
}: {
	file: string;
	codecAudio: string;
}): Promise<void> {
	await execFileAsync(
		"ffmpeg",
		[
			"-y",
			"-nostdin",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=64x64:d=1:r=10",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:v",
			"libx264",
			"-c:a",
			codecAudio,
			"-shortest",
			file,
		],
		{ timeout: 60_000 },
	);
}

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "klip-audio-"));
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("normalisasi audio ke AAC", () => {
	test("MP4 ber-audio Opus ditranskode menjadi AAC, videonya tidak disentuh", async () => {
		if (!(await ffmpegSiap())) return;
		const file = path.join(dir, "opus.mp4");
		await buatUji({ file, codecAudio: "libopus" });
		expect(await kodekAudio({ file })).toBe("opus");

		const hasil = await pastikanAudioAac({ absPath: file });

		expect(hasil.diubah).toBe(true);
		expect(await kodekAudio({ file })).toBe("aac");
	});

	test("MP4 yang sudah AAC tidak diubah", async () => {
		if (!(await ffmpegSiap())) return;
		const file = path.join(dir, "aac.mp4");
		await buatUji({ file, codecAudio: "aac" });

		const hasil = await pastikanAudioAac({ absPath: file });

		expect(hasil.diubah).toBe(false);
		expect(hasil.keterangan).toContain("aac");
	});

	test("berkas tanpa audio dilewati tanpa error", async () => {
		if (!(await ffmpegSiap())) return;
		const file = path.join(dir, "senyap.mp4");
		await execFileAsync(
			"ffmpeg",
			[
				"-y",
				"-nostdin",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=64x64:d=1:r=10",
				"-c:v",
				"libx264",
				file,
			],
			{ timeout: 60_000 },
		);

		const hasil = await pastikanAudioAac({ absPath: file });

		expect(hasil.diubah).toBe(false);
		expect(hasil.keterangan).toContain("tanpa audio");
	});
});
