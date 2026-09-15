/**
 * Antrikan video lokal sebagai batch.
 *
 * KENAPA ADA: menguji seluruh alur (render -> publish) lewat UI berarti harus
 * membuat ZIP dulu. Skrip ini membuatkannya, jadi uji cukup satu perintah.
 * Juga berguna untuk pemakaian API-driven.
 *
 * PAKAI:
 *   bun run klip:queue <berkas.mp4> --caption "teks" [--template <id>] [--ig <id>]
 *   bun run klip:queue <berkas.zip>  [--template <id>] [--ig <id>]
 *
 * DUA BENTUK INPUT:
 *   .mp4 -> dibungkus jadi ZIP satu entri bernama "clip_01_<nama>.mp4".
 *           Awalan clip_NN_ penting: itu yang dipakai memasangkan caption.
 *   .zip -> DIPAKAI APA ADANYA. ZIP yang sudah berisi captions.json harus
 *           lewat jalur ini; membungkusnya ulang akan mengurung captions.json
 *           di dalam byte video dan caption hilang tanpa error.
 *
 * Tanpa --ig, akun tujuan diambil dari setelan default_ig_account_id; kalau
 * setelan itu kosong, video hanya dirender dan publish dilewati.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveBatchZip } from "@/klip/batch-store";
import { createBatch, resolveDefaultOwnerUserId } from "@/klip/batch-service";
import { MAX_CAPTION_LENGTH } from "@/klip/ig-publish";

function flag({ name }: { name: string }): string | null {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1) return null;
	const value = process.argv[i + 1];
	return value && !value.startsWith("--") ? value : null;
}

async function main(): Promise<void> {
	const file = process.argv[2];
	if (!file || file.startsWith("--")) {
		throw new Error(
			'pakai: bun run klip:queue <berkas.mp4|berkas.zip> [--caption "teks"] [--template <id>] [--ig <id>]',
		);
	}
	const ownerUserId = resolveDefaultOwnerUserId();
	if (!ownerUserId) {
		throw new Error("APP_USER (atau KLIP_OWNER_ID) belum diisi");
	}

	const caption = flag({ name: "caption" })?.slice(0, MAX_CAPTION_LENGTH) ?? null;
	const templateId = flag({ name: "template" });
	const igAccountId = flag({ name: "ig" });

	const isZip = path.extname(file).toLowerCase() === ".zip";
	// ZIP dipakai apa adanya supaya captions.json di dalamnya tetap terbaca.
	// Kalau dibungkus ulang, captions.json ikut terkubur di dalam byte video.
	const source = await readFile(file);
	const batchId = `uji_${Date.now().toString(36)}`;
	const bytes = isZip ? source : null;
	let entryName: string;
	let zipPath: string;

	if (isZip) {
		zipPath = await saveBatchZip({ batchId, bytes: source });
		// Daftar entri video dibaca dari ZIP-nya, memakai guard yang sama dengan
		// endpoint HTTP - jadi zip-slip tetap tertutup di jalur CLI ini juga.
		const { listZipEntries } = await import("@/klip/batch-store");
		const entries = await listZipEntries({
			absPath: path.join(
				(await import("@/klip/upload")).dataRoot(),
				zipPath,
			),
		});
		const videos = entries.filter((e) => /\.(mp4|webm|mov)$/i.test(e.name));
		if (videos.length === 0) {
			throw new Error(`ZIP tidak berisi video yang dikenali: ${file}`);
		}
		// Satu batch bisa berisi banyak video; batchId di atas hanya untuk nama ZIP.
		const created = await createBatch({
			input: {
				zipPath,
				zipBytes: source.length,
				entryNames: videos.map((v) => v.name),
				templateId,
				caption,
				igAccountId,
				source: "api",
				ownerUserId,
			},
		});
		console.log(`batch ${created.id} dibuat: ${videos.length} job dari ZIP`);
		for (const v of videos) console.log(`  - ${v.name}`);
		console.log(`  template : ${created.templateId ?? "(default)"}`);
		console.log(`  akun IG  : ${created.igAccountId ?? "(default dari setelan)"}`);
		return;
	}

	// Jalur .mp4: bungkus jadi ZIP satu entri. Awalan "clip_01_" WAJIB - itu
	// nomor yang dipakai memasangkan caption dari captions.json.
	entryName = `clip_01_${path.basename(file).replace(/[^\w.-]+/g, "_")}`;
	zipPath = await saveBatchZip({
		batchId,
		bytes: await buildZip({ entryName, bytes: source }),
	});

	const created = await createBatch({
		input: {
			zipPath,
			zipBytes: source.length,
			entryNames: [entryName],
			templateId,
			caption,
			igAccountId,
			source: "upload",
			ownerUserId,
		},
	});
	console.log(`batch ${created.id} dibuat: 1 job (${entryName})`);
	console.log(`  template : ${created.templateId ?? "(default)"}`);
	console.log(`  caption  : ${created.caption ?? "(tanpa caption)"}`);
	console.log(`  akun IG  : ${created.igAccountId ?? "(default dari setelan)"}`);
}

/** ZIP satu entri, disusun manual supaya tidak menambah dependensi. */
async function buildZip({
	entryName,
	bytes,
}: {
	entryName: string;
	bytes: Buffer;
}): Promise<Buffer> {
	const name = Buffer.from(entryName, "utf8");
	const crc = crc32(bytes);

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // versi minimum
	local.writeUInt16LE(0, 6); // flag
	local.writeUInt16LE(0, 8); // metode: stored (tanpa kompresi)
	local.writeUInt16LE(0, 10); // waktu
	local.writeUInt16LE(0, 12); // tanggal
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(bytes.length, 18);
	local.writeUInt32LE(bytes.length, 22);
	local.writeUInt16LE(name.length, 26);
	local.writeUInt16LE(0, 28);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0, 8);
	central.writeUInt16LE(0, 10);
	central.writeUInt16LE(0, 12);
	central.writeUInt16LE(0, 14);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(bytes.length, 20);
	central.writeUInt32LE(bytes.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(0, 42); // offset local header

	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + bytes.length, 16);

	return Buffer.concat([local, name, bytes, central, name, end]);
}

/** CRC32 sesuai spesifikasi ZIP. */
function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
	}
	return (c ^ 0xffffffff) >>> 0;
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
