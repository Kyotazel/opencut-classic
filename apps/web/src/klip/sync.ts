import type { MediaAsset, MediaType } from "@/media/types";
import type { SerializedProject } from "@/services/storage/types";

// Dynamic import: modul storage menarik opencut-wasm yang tidak ada di env test.
async function getStorageService() {
	const mod = await import("@/services/storage/service");
	return mod.storageService;
}

const BASE_PREFIX = "klip_sync_base:";

export class SyncConflictError extends Error {
	serverUpdatedAt: string;

	constructor({ serverUpdatedAt }: { serverUpdatedAt: string }) {
		super("Server menyimpan versi lebih baru");
		this.name = "SyncConflictError";
		this.serverUpdatedAt = serverUpdatedAt;
	}
}

export function getSyncBase({ id }: { id: string }): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem(`${BASE_PREFIX}${id}`);
	} catch {
		return null;
	}
}

export function setSyncBase({ id, updatedAt }: { id: string; updatedAt: string }): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(`${BASE_PREFIX}${id}`, updatedAt);
	} catch {
		// abaikan (mode privat dsb), sync tetap jalan tanpa penanda base
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readError({ res, fallback }: { res: Response; fallback: string }): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (!isRecord(body)) return `${fallback}: ${res.status}`;
		const err = body["error"];
		return typeof err === "string" ? err : `${fallback}: ${res.status}`;
	} catch {
		return `${fallback}: ${res.status}`;
	}
}

function mediaTypeFromMime({ mime }: { mime: string }): MediaType | null {
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("audio/")) return "audio";
	return null;
}

export async function pullProject({ id }: { id: string }): Promise<{
	pulled: boolean;
	skippedMedia: number;
}> {
	const res = await fetch(`/api/sync/projects/${encodeURIComponent(id)}`);
	if (res.status === 404) return { pulled: false, skippedMedia: 0 };
	if (!res.ok) throw new Error(await readError({ res, fallback: "Gagal mengambil project" }));
	const body: unknown = await res.json();
	const rec = isRecord(body) ? body : null;
	const data = rec?.["data"];
	const serverUpdatedAt = rec?.["updatedAt"];
	if (typeof data !== "string" || typeof serverUpdatedAt !== "string") {
		throw new Error("Respons server tidak valid");
	}
	let serialized: SerializedProject;
	try {
		serialized = JSON.parse(data);
	} catch {
		throw new Error("Data project server rusak");
	}
	const meta: unknown = serialized.metadata;
	if (!isRecord(meta) || meta["id"] !== id) {
		throw new Error("Data project server tidak cocok");
	}
	const storage = await getStorageService();
	await storage.putSerializedProject({ project: serialized });
	const mediaRes = await fetch(`/api/sync/projects/${encodeURIComponent(id)}/media`);
	if (!mediaRes.ok) throw new Error(await readError({ res: mediaRes, fallback: "Gagal mengambil daftar media" }));
	const mediaBody: unknown = await mediaRes.json();
	const mediaRec = isRecord(mediaBody) ? mediaBody : null;
	const list = mediaRec?.["media"];
	const items = Array.isArray(list) ? list : [];
	let skippedMedia = 0;
	for (const raw of items) {
		if (!isRecord(raw)) {
			skippedMedia += 1;
			continue;
		}
		if (typeof raw["id"] !== "string" || typeof raw["mime"] !== "string") {
			skippedMedia += 1;
			continue;
		}
		const type = mediaTypeFromMime({ mime: raw["mime"] });
		if (!type) {
			skippedMedia += 1;
			continue;
		}
		const storage = await getStorageService();
		const existing = await storage.loadMediaAsset({ projectId: id, id: raw["id"] });
		if (existing) continue;
		const fileRes = await fetch(`/api/sync/media/${encodeURIComponent(raw["id"])}`);
		if (!fileRes.ok) {
			skippedMedia += 1;
			continue;
		}
		const bytes = await fileRes.arrayBuffer();
		await storage.saveMediaAsset({
			projectId: id,
			mediaAsset: {
				id: raw["id"],
				name: raw["id"],
				type,
				file: new File([bytes], raw["id"], { type: raw["mime"] }),
			},
		});
	}
	setSyncBase({ id, updatedAt: serverUpdatedAt });
	return { pulled: true, skippedMedia };
}


/**
 * Siapkan File untuk diunggah, dengan nama asli dan tipe yang benar.
 *
 * OPFS hanya menyimpan isi berkas: nama yang dikembalikan adalah key-nya
 * (id asset berupa UUID) dan tipenya kosong. Metadata di IndexedDB menyimpan
 * nama asli, jadi File disusun ulang dari situ. Tanpa ini server menerima
 * berkas tanpa ekstensi dan menyimpannya sebagai octet-stream.
 */
function fileForUpload({ asset }: { asset: MediaAsset }): File {
	const type = asset.file.type || mimeFromName({ name: asset.name }) || asset.type;
	if (asset.file.name === asset.name && asset.file.type) return asset.file;
	return new File([asset.file], asset.name, { type });
}

/** MIME dari ekstensi nama berkas. */
function mimeFromName({ name }: { name: string }): string {
	const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
	const map: Record<string, string> = {
		".mp4": "video/mp4",
		".m4v": "video/mp4",
		".webm": "video/webm",
		".mov": "video/quicktime",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".svg": "image/svg+xml",
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".m4a": "audio/mp4",
		".ogg": "audio/ogg",
	};
	return map[ext] ?? "";
}

export async function pushProject({
	id,
	forceBase,
}: {
	id: string;
	forceBase?: string;
}): Promise<{ updatedAt: string }> {
	const storage = await getStorageService();
	const serialized = await storage.getSerializedProject({ id });
	if (!serialized) throw new Error("Project tidak ada di browser ini");
	const res = await fetch(`/api/sync/projects/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: serialized.metadata.name,
			data: JSON.stringify(serialized),
			baseUpdatedAt: forceBase ?? getSyncBase({ id }),
		}),
	});
	if (res.status === 409) {
		let serverUpdatedAt = "";
		try {
			const body: unknown = await res.json();
			if (isRecord(body) && typeof body["serverUpdatedAt"] === "string") {
				serverUpdatedAt = body["serverUpdatedAt"];
			}
		} catch {
			// abaikan
		}
		throw new SyncConflictError({ serverUpdatedAt });
	}
	if (!res.ok) throw new Error(await readError({ res, fallback: "Gagal menyimpan project" }));
	const body: unknown = await res.json();
	const rec = isRecord(body) ? body : null;
	if (typeof rec?.["updatedAt"] !== "string") throw new Error("Respons server tidak valid");
	const updatedAt = rec["updatedAt"];

	const mediaRes = await fetch(`/api/sync/projects/${encodeURIComponent(id)}/media`);
	const serverIds = new Set<string>();
	if (mediaRes.ok) {
		const mediaBody: unknown = await mediaRes.json();
		const mediaRec = isRecord(mediaBody) ? mediaBody : null;
		const list = mediaRec?.["media"];
		if (Array.isArray(list)) {
			for (const raw of list) {
				if (isRecord(raw) && typeof raw["id"] === "string") serverIds.add(raw["id"]);
			}
		}
	}
	const localAssets = await storage.loadAllMediaAssets({ projectId: id });
	for (const asset of localAssets) {
		if (serverIds.has(asset.id)) continue;
		const form = new FormData();
		form.set("assetId", asset.id);
		// OPFS mengembalikan File dengan nama = key (id asset, berupa UUID) dan
		// TANPA tipe MIME - OPFS hanya menyimpan isi berkas. Kalau dikirim apa
		// adanya, server tidak punya cara mengenali jenis berkasnya dan
		// menyimpannya sebagai octet-stream + .bin; editor lalu menolak
		// memuatnya dan preview jadi hitam.
		//
		// Nama asli ada di metadata (IndexedDB), jadi File disusun ulang dengan
		// nama itu - ekstensinya yang dipakai server untuk menentukan MIME.
		form.set("file", fileForUpload({ asset }));
		const up = await fetch(`/api/sync/projects/${encodeURIComponent(id)}/media`, {
			method: "POST",
			body: form,
		});
		if (!up.ok) throw new Error(await readError({ res: up, fallback: `Gagal mengunggah media ${asset.id}` }));
	}
	setSyncBase({ id, updatedAt });
	return { updatedAt };
}
