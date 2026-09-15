export const IG_API_BASE = "https://graph.instagram.com";
export const IG_OAUTH_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
export const IG_OAUTH_TOKEN = "https://api.instagram.com/oauth/access_token";
export const IG_SCOPES = [
	"instagram_business_basic",
	"instagram_business_content_publish",
];
export const IG_API_VERSION = "v26.0";

export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchFn = fetch;

/** @internal override HTTP untuk test */
export function __setFetchMock(fn: FetchFn): void {
	fetchImpl = fn;
}

function asRecord({ value }: { value: unknown }): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Respons Instagram tidak valid (bukan JSON object)");
	}
	return Object.fromEntries(Object.entries(value));
}

function strField({
	rec,
	name,
}: {
	rec: Record<string, unknown>;
	name: string;
}): string | null {
	const v = rec[name];
	return typeof v === "string" ? v : null;
}

function requireIgEnv(): {
	appId: string;
	appSecret: string;
	redirectUri: string;
} {
	const { IG_APP_ID, IG_APP_SECRET, IG_REDIRECT_URI } = process.env;
	if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT_URI) {
		throw new Error(
			"IG_APP_ID / IG_APP_SECRET / IG_REDIRECT_URI belum dipasang di env server",
		);
	}
	return { appId: IG_APP_ID, appSecret: IG_APP_SECRET, redirectUri: IG_REDIRECT_URI };
}

export function buildAuthorizeUrl(state: string): string {
	const { appId, redirectUri } = requireIgEnv();
	const q = new URLSearchParams({
		client_id: appId,
		redirect_uri: redirectUri,
		scope: IG_SCOPES.join(","),
		response_type: "code",
		state,
	});
	return `${IG_OAUTH_AUTHORIZE}?${q.toString()}`;
}

export async function exchangeCodeForToken(
	code: string,
): Promise<{ accessToken: string; userId: string }> {
	const { appId, appSecret, redirectUri } = requireIgEnv();
	const body = new URLSearchParams({
		client_id: appId,
		client_secret: appSecret,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
		code,
	});
	const res = await fetchImpl(IG_OAUTH_TOKEN, { method: "POST", body });
	if (!res.ok) {
		throw new Error(`Instagram token exchange gagal: ${res.status}`);
	}
	const rec = asRecord({ value: await res.json() });
	const accessToken = strField({ rec, name: "access_token" });
	const userId = rec["user_id"];
	if (!accessToken || (typeof userId !== "string" && typeof userId !== "number")) {
		throw new Error("Respons Instagram token tidak valid");
	}
	return { accessToken, userId: String(userId) };
}

export async function exchangeForLongLivedToken(
	shortLived: string,
): Promise<{ accessToken: string; expiresIn: number }> {
	const { appSecret } = requireIgEnv();
	const q = new URLSearchParams({
		grant_type: "ig_exchange_token",
		client_secret: appSecret,
		access_token: shortLived,
	});
	const res = await fetchImpl(`${IG_API_BASE}/access_token?${q.toString()}`);
	if (!res.ok) {
		throw new Error(`Instagram long-lived exchange gagal: ${res.status}`);
	}
	const rec = asRecord({ value: await res.json() });
	const accessToken = strField({ rec, name: "access_token" });
	const expiresIn = rec["expires_in"];
	if (!accessToken || typeof expiresIn !== "number") {
		throw new Error("Respons Instagram long-lived token tidak valid");
	}
	return { accessToken, expiresIn };
}

export async function fetchIgProfile(
	accessToken: string,
): Promise<{ id: string; username: string; profilePicUrl: string | null }> {
	const q = new URLSearchParams({
		fields: "user_id,username,profile_picture_url",
		access_token: accessToken,
	});
	const res = await fetchImpl(
		`${IG_API_BASE}/${IG_API_VERSION}/me?${q.toString()}`,
	);
	if (!res.ok) {
		const err = new Error(`Instagram profile gagal: ${res.status}`) as Error & {
			igStatus?: number;
		};
		err.igStatus = res.status;
		throw err;
	}
	const rec = asRecord({ value: await res.json() });
	const rawId = rec["user_id"] ?? rec["id"];
	const username = strField({ rec, name: "username" });
	if ((typeof rawId !== "string" && typeof rawId !== "number") || !username) {
		throw new Error("Respons Instagram profile tidak valid");
	}
	return {
		id: String(rawId),
		username,
		profilePicUrl: strField({ rec, name: "profile_picture_url" }),
	};
}

export type ReelStage = "upload" | "processing" | "published";

export interface PublishReelOpts {
	igUserId: string;
	accessToken: string;
	caption: string;
	videoBytes: ArrayBuffer;
	/** URL publik file mp4; dipakai hanya bila Meta menolak resumable upload. */
	videoUrl?: string;
	pollIntervalMs?: number;
	onStage?: (stage: ReelStage) => void;
}

/**
 * Batas jumlah pemeriksaan status container.
 *
 * Dengan jeda 60 detik, 30 percobaan berarti 30 menit - jauh lebih dari cukup:
 * Meta memproses container Reels dalam puluhan detik, dan container yang belum
 * siap setelah 30 menit berarti ada yang salah.
 */
const POLL_MAX_TRIES = 30;

/**
 * Jeda antar pemeriksaan status container.
 *
 * KENAPA 60 DETIK, BUKAN 5: setiap pemeriksaan adalah satu panggilan API, dan
 * kuota panggilan Instagram dihitung per 24 jam sebagai
 * `4800 * jumlah penayangan` - akun testing yang sedikit dilihat berarti kuota
 * kecil. Dengan jeda 5 detik, satu video bisa memakan sampai 60 panggilan
 * hanya untuk polling, dan kuota habis karena kita sendiri yang menggedor.
 * Jeda 60 detik memotong biaya itu sekitar 12x.
 */
const POLL_INTERVAL_MS = 60_000;

/** Pemakaian kuota yang dianggap kritis; di atas ini kita mundur dulu. */
export const BATAS_PEMAKAIAN_KRITIS = 90;
/** Umur maksimum nilai pemakaian yang masih dipercaya. */
const UMUR_PEMAKAIAN_MS = 10 * 60_000;

/**
 * Pemakaian kuota terakhir yang dilaporkan Meta, dari header respons.
 *
 * Meta mengirim X-Business-Use-Case-Usage dan X-App-Usage berisi persentase
 * pemakaian. Nilainya dipakai untuk MUNDUR SEBELUM menabrak: menerbitkan saat
 * kuota hampir habis hanya menghasilkan kegagalan yang menghabiskan sisa kuota.
 *
 * Nilai basi sengaja tidak dipercaya - kalau tidak, setelah mundur kita akan
 * membaca angka lama yang masih tinggi dan mundur lagi tanpa henti.
 */
let pemakaianKuota: { nilai: number; pada: number } | null = null;

/**
 * Perkiraan Meta kapan akses pulih, dalam MENIT.
 *
 * Diambil dari `estimated_time_to_regain_access` di header
 * X-Business-Use-Case-Usage. Ini angka resmi dari Meta, jadi jauh lebih baik
 * daripada menebak "kira-kira sejam cukup" - terutama karena jendela kuota
 * bergulir 24 jam dan pemulihannya bertahap.
 */
let estimasiPulihMenit: { nilai: number; pada: number } | null = null;

/** Perkiraan waktu pulih (menit) dari Meta, atau null kalau tidak diketahui/basi. */
export function estimasiPulihKuotaMenit(): number | null {
	if (!estimasiPulihMenit) return null;
	if (Date.now() - estimasiPulihMenit.pada > UMUR_PEMAKAIAN_MS) return null;
	return estimasiPulihMenit.nilai;
}

/** Buang seluruh catatan kuota. Dipakai tes dan setelah publish berhasil. */
export function __lupakanPemakaianKuota(): void {
	pemakaianKuota = null;
	estimasiPulihMenit = null;
}

/** Persentase pemakaian kuota terakhir, atau null kalau tidak diketahui/basi. */
export function pemakaianKuotaTerakhir(): number | null {
	if (!pemakaianKuota) return null;
	if (Date.now() - pemakaianKuota.pada > UMUR_PEMAKAIAN_MS) return null;
	return pemakaianKuota.nilai;
}

/** Catat pemakaian kuota dari header respons. Tidak pernah melempar. */
function catatPemakaian({ res }: { res: Response }): void {
	try {
		const angka: number[] = [];
		const tambah = (v: unknown) => {
			if (typeof v === "number" && Number.isFinite(v)) angka.push(v);
		};
		for (const nama of ["x-business-use-case-usage", "x-app-usage"]) {
			const raw = res.headers.get(nama);
			if (!raw) continue;
			const parsed: unknown = JSON.parse(raw);
			// Dua bentuk berbeda:
			//   X-App-Usage               : { call_count, total_cputime, total_time }
			//   X-Business-Use-Case-Usage : { "<id>": [ { call_count, ... } ] }
			//
			// Bentuk datar sempat TIDAK terbaca: nilainya berupa angka, sedangkan
			// pengumpulnya hanya menerima objek - sehingga header yang paling
			// umum justru diabaikan tanpa error.
			const rekaman: Record<string, unknown>[] = [];
			const kumpulkan = (v: unknown): void => {
				if (Array.isArray(v)) {
					for (const isi of v) kumpulkan(isi);
					return;
				}
				// Object.fromEntries dipakai alih-alih assertion tipe: repo ini
				// melarang assertion yang mempersempit tipe.
				if (v !== null && typeof v === "object") {
					rekaman.push(Object.fromEntries(Object.entries(v)));
				}
			};
			if (Array.isArray(parsed)) {
				kumpulkan(parsed);
			} else if (parsed !== null && typeof parsed === "object") {
				const rec = Object.fromEntries(Object.entries(parsed));
				const datar =
					"call_count" in rec || "total_cputime" in rec || "total_time" in rec;
				if (datar) rekaman.push(rec);
				else for (const v of Object.values(rec)) kumpulkan(v);
			}
			for (const rec of rekaman) {
				tambah(rec["call_count"]);
				tambah(rec["total_cputime"]);
				tambah(rec["total_time"]);
				const pulih = rec["estimated_time_to_regain_access"];
				if (typeof pulih === "number" && Number.isFinite(pulih)) {
					// Nilai terbesar dipakai: kalau beberapa business object
					// melaporkan, yang paling lama yang menentukan.
					estimasiPulihMenit = {
						nilai: Math.max(estimasiPulihMenit?.nilai ?? 0, pulih),
						pada: Date.now(),
					};
				}
			}
		}
		if (angka.length > 0) {
			pemakaianKuota = { nilai: Math.max(...angka), pada: Date.now() };
		}
	} catch {
		// Header bukan JSON yang dikenal; abaikan.
	}
}

function childRecord({
	rec,
	name,
}: {
	rec: Record<string, unknown>;
	name: string;
}): Record<string, unknown> | null {
	const v = rec[name];
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	return Object.fromEntries(Object.entries(v));
}

function snippet({ text }: { text: string }): string {
	const oneLine = text.replace(/\s+/g, " ").slice(0, 300);
	return oneLine ? ` | respons: ${oneLine}` : " | respons kosong";
}

function igError({
	status,
	rec,
	where,
}: {
	status: number;
	rec: Record<string, unknown> | null;
	where: string;
}): Error {
	const errRec = rec ? childRecord({ rec, name: "error" }) : null;
	const fromErr = errRec ? strField({ rec: errRec, name: "message" }) : null;
	const fallback = rec
		? (strField({ rec, name: "message" }) ?? strField({ rec, name: "status" }))
		: null;
	const detail = fromErr ?? fallback ?? `HTTP ${status}`;
	const code = errRec?.["code"];
	if (status === 401 || code === 190) {
		return new Error(`IG_TOKEN_INVALID: ${detail} (${where})`);
	}
	return new Error(`Instagram API gagal [${where}]: ${detail}`);
}

function parseJsonObject({ text }: { text: string }): Record<string, unknown> | null {
	if (!text) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}

async function igRequest({
	method,
	path,
	token,
	params,
	body,
	headers,
}: {
	method: "GET" | "POST";
	path: string;
	token: string;
	params?: Record<string, string>;
	body?: BodyInit;
	headers?: Record<string, string>;
}): Promise<Record<string, unknown>> {
	const where = `${method} ${path}`;
	const q = new URLSearchParams({ access_token: token, ...(params ?? {}) });
	let res: Response;
	try {
		res = await fetchImpl(`${IG_API_BASE}/${IG_API_VERSION}${path}?${q.toString()}`, {
			method,
			body,
			headers,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "jaringan gagal";
		throw new Error(`Instagram API gagal [${where}]: jaringan/server tak terjangkau (${message})`);
	}
	catatPemakaian({ res });
	const text = await res.text().catch(() => "");
	const rec = parseJsonObject({ text });
	if (!res.ok || !rec) {
		console.error(
			`[ig-api] ${where} -> HTTP ${res.status}${snippet({ text })}` +
				(pemakaianKuota ? ` | pemakaian kuota: ${pemakaianKuota.nilai}%` : ""),
		);
	}
	if (!rec) {
		throw new Error(
			`Instagram API gagal [${where}]: respons bukan JSON object (HTTP ${res.status})${snippet({ text })}`,
		);
	}
	if (!res.ok) throw igError({ status: res.status, rec, where });
	return rec;
}

async function createReelUploadSession({
	igUserId,
	token,
	caption,
}: {
	igUserId: string;
	token: string;
	caption: string;
}): Promise<{ containerId: string; uploadUri: string }> {
	const params: Record<string, string> = {
		media_type: "REELS",
		upload_type: "resumable",
		share_to_feed: "true",
	};
	if (caption) params["caption"] = caption;
	const rec = await igRequest({ method: "POST", path: `/${igUserId}/media`, token, params });
	const containerId = strField({ rec, name: "id" });
	const uploadUri = strField({ rec, name: "uri" });
	if (!containerId || !uploadUri) {
		throw new Error("Instagram tidak mengembalikan container id / upload uri");
	}
	return { containerId, uploadUri };
}

async function uploadBytes({
	uploadUri,
	token,
	videoBytes,
}: {
	uploadUri: string;
	token: string;
	videoBytes: ArrayBuffer;
}): Promise<void> {
	const res = await fetchImpl(uploadUri, {
		method: "POST",
		headers: {
			Authorization: `OAuth ${token}`,
			offset: "0",
			file_size: String(videoBytes.byteLength),
		},
		body: videoBytes,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		console.error(`[ig-api] POST rupload -> HTTP ${res.status}${snippet({ text })}`);
		throw igError({ status: res.status, rec: parseJsonObject({ text }), where: "POST rupload" });
	}
}

function isVideoUrlRequired({ message }: { message: string }): boolean {
	return message.toLowerCase().includes("video_url");
}

async function createReelContainerViaUrl({
	igUserId,
	token,
	caption,
	videoUrl,
}: {
	igUserId: string;
	token: string;
	caption: string;
	videoUrl: string;
}): Promise<string> {
	const params: Record<string, string> = {
		media_type: "REELS",
		video_url: videoUrl,
		share_to_feed: "true",
	};
	if (caption) params["caption"] = caption;
	const rec = await igRequest({ method: "POST", path: `/${igUserId}/media`, token, params });
	const id = strField({ rec, name: "id" });
	if (!id) throw new Error("Instagram tidak mengembalikan container id");
	return id;
}

async function pollContainer({
	containerId,
	token,
	pollIntervalMs,
	viaVideoUrl,
}: {
	containerId: string;
	token: string;
	pollIntervalMs: number;
	/**
	 * URL yang dipakai Meta untuk MENGUNDUH video, kalau container dibuat
	 * lewat video_url. Dipakai hanya untuk pesan kesalahan.
	 *
	 * Kenapa perlu: Meta membalas {status_code:"ERROR", status:"ERROR"} tanpa
	 * keterangan apa pun. Tanpa menyebut URL-nya, kesalahan yang paling sering
	 * - URL tidak bisa diunduh dari internet - tidak bisa dibedakan dari video
	 * yang memang tidak valid.
	 */
	viaVideoUrl: string | null;
}): Promise<void> {
	for (let i = 0; i < POLL_MAX_TRIES; i += 1) {
		const rec = await igRequest({
			method: "GET",
			path: `/${containerId}`,
			token,
			params: { fields: "status_code,status" },
		});
		const code = strField({ rec: rec, name: "status_code" });
		if (code === "FINISHED") return;
		if (code === "ERROR") {
			const detail = strField({ rec: rec, name: "status" });
			const sebab = detail && detail !== "ERROR" ? detail : "Instagram tidak memberi keterangan";
			const sumber = viaVideoUrl
				? ` Container ${containerId} dibuat dari video_url ${viaVideoUrl} - pastikan URL itu bisa diunduh dari internet dan menunjuk aplikasi ini (KLIP_PUBLIC_BASE_URL).`
				: ` Container ${containerId} diunggah langsung (resumable).`;
			throw new Error(`Instagram gagal memproses video: ${sebab}.${sumber}`);
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
	throw new Error("Timeout menunggu Instagram memproses video");
}

async function publishContainer({
	igUserId,
	token,
	containerId,
}: {
	igUserId: string;
	token: string;
	containerId: string;
}): Promise<string> {
	const rec = await igRequest({
		method: "POST",
		path: `/${igUserId}/media_publish`,
		token,
		params: { creation_id: containerId },
	});
	const direct = strField({ rec: rec, name: "permalink" });
	const mediaId = strField({ rec: rec, name: "id" });
	if (direct) return direct;
	if (!mediaId) throw new Error("Instagram tidak mengembalikan media id");
	const media = await igRequest({
		method: "GET",
		path: `/${mediaId}`,
		token,
		params: { fields: "permalink" },
	});
	const permalink = strField({ rec: media, name: "permalink" });
	if (!permalink) throw new Error("Instagram tidak mengembalikan permalink");
	return permalink;
}

export async function publishReel(opts: PublishReelOpts): Promise<{
	containerId: string;
	permalink: string;
}> {
	const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
	opts.onStage?.("upload");
	let containerId: string;
	// Diisi kalau jalur video_url yang dipakai, supaya pesan kesalahan nanti
	// bisa menyebut URL mana yang gagal.
	let viaVideoUrl: string | null = null;
	try {
		const session = await createReelUploadSession({
			igUserId: opts.igUserId,
			token: opts.accessToken,
			caption: opts.caption,
		});
		await uploadBytes({
			uploadUri: session.uploadUri,
			token: opts.accessToken,
			videoBytes: opts.videoBytes,
		});
		containerId = session.containerId;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Publish gagal";
		const videoUrl = opts.videoUrl;
		if (!isVideoUrlRequired({ message })) throw error;
		if (!videoUrl) {
			throw new Error(
				"Instagram menolak resumable upload (video_url required). Pasang KLIP_PUBLIC_BASE_URL di env server lalu retry publish.",
			);
		}
		containerId = await createReelContainerViaUrl({
			igUserId: opts.igUserId,
			token: opts.accessToken,
			caption: opts.caption,
			videoUrl,
		});
		viaVideoUrl = videoUrl;
	}
	opts.onStage?.("processing");
	await pollContainer({
		containerId,
		token: opts.accessToken,
		pollIntervalMs,
		viaVideoUrl,
	});
	const permalink = await publishContainer({
		igUserId: opts.igUserId,
		token: opts.accessToken,
		containerId,
	});
	opts.onStage?.("published");
	return { containerId, permalink };
}
