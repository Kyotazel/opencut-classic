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

const POLL_MAX_TRIES = 60;

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

function igError({ status, rec }: { status: number; rec: Record<string, unknown> }): Error {
	const errRec = childRecord({ rec, name: "error" });
	const fromErr = errRec ? strField({ rec: errRec, name: "message" }) : null;
	const fallback = strField({ rec, name: "message" }) ?? strField({ rec, name: "status" });
	const detail = fromErr ?? fallback ?? `HTTP ${status}`;
	const code = errRec?.["code"];
	if (status === 401 || code === 190) {
		return new Error(`IG_TOKEN_INVALID: ${detail}`);
	}
	return new Error(`Instagram API gagal: ${detail}`);
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
	const q = new URLSearchParams({ access_token: token, ...(params ?? {}) });
	const res = await fetchImpl(`${IG_API_BASE}/${IG_API_VERSION}${path}?${q.toString()}`, {
		method,
		body,
		headers,
	});
	const rec = asRecord({ value: await res.json().catch(() => null) });
	if (!res.ok) throw igError({ status: res.status, rec });
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
		const rec = asRecord({ value: await res.json().catch(() => null) });
		throw igError({ status: res.status, rec });
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
}: {
	containerId: string;
	token: string;
	pollIntervalMs: number;
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
			throw new Error(strField({ rec: rec, name: "status" }) ?? "Pemrosesan video gagal di Instagram");
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
	const pollIntervalMs = opts.pollIntervalMs ?? 5000;
	opts.onStage?.("upload");
	let containerId: string;
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
	}
	opts.onStage?.("processing");
	await pollContainer({ containerId, token: opts.accessToken, pollIntervalMs });
	const permalink = await publishContainer({
		igUserId: opts.igUserId,
		token: opts.accessToken,
		containerId,
	});
	opts.onStage?.("published");
	return { containerId, permalink };
}
