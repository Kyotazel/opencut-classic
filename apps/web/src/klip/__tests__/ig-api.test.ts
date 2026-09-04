import { beforeEach, describe, expect, test } from "bun:test";
import { __setFetchMock, publishReel } from "@/klip/ig-api";

function jsonResponse({ body, status }: { body: unknown; status?: number }): Response {
	return new Response(JSON.stringify(body), {
		status: status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

const BASE = "https://graph.instagram.com/v26.0";

describe("ig-api publishReel", () => {
	beforeEach(() => {
		__setFetchMock(async () => jsonResponse({ body: {} }));
	});

	test("sukses penuh mengembalikan permalink dan stage berurutan", async () => {
		const calls: string[] = [];
		__setFetchMock(async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			const method = init?.method ?? "GET";
			calls.push(`${method} ${u.split("?")[0]}`);
			if (u.startsWith(`${BASE}/123/media_publish`)) {
				return jsonResponse({ body: { id: "media-9" } })
			}
			if (u.startsWith(`${BASE}/123/media`)) {
				expect(method).toBe("POST");
				return jsonResponse({ body: { id: "container-1", uri: "https://rupload.example/v26.0/container-1" } })
			}
			if (u.startsWith("https://rupload.example/")) {
				expect(method).toBe("POST");
				return new Response(null, { status: 200 })
			}
			if (u.startsWith(`${BASE}/container-1`)) {
				return jsonResponse({ body: { status_code: "FINISHED" } })
			}
			if (u.startsWith(`${BASE}/media-9`)) {
				return jsonResponse({ body: { permalink: "https://ig.example/p/9" } })
			}
			return jsonResponse({ body: { error: { message: "not mocked" } }, status: 404 })
		});
		const stages: string[] = [];
		const result = await publishReel({
			igUserId: "123",
			accessToken: "tok",
			caption: "halo",
			videoBytes: new Uint8Array([1, 2, 3]).buffer,
			pollIntervalMs: 1,
			onStage: (s) => stages.push(s),
		});
		expect(result).toEqual({ containerId: "container-1", permalink: "https://ig.example/p/9" });
		expect(stages).toEqual(["upload", "processing", "published"]);
		expect(calls).toContain(`POST ${BASE}/123/media_publish`);
	});

	test("container ERROR melempar pesan Meta", async () => {
		__setFetchMock(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes("/123/media")) {
				return jsonResponse({ body: { id: "container-2", uri: "https://rupload.example/v26.0/container-2" } })
			}
			if (u.startsWith("https://rupload.example/")) return new Response(null, { status: 200 })
			return jsonResponse({ body: { status_code: "ERROR", status: "Video tidak valid" } })
		});
		await expect(
			publishReel({
				igUserId: "123",
				accessToken: "tok",
				caption: "",
				videoBytes: new Uint8Array([1]).buffer,
				pollIntervalMs: 1,
			}),
		).rejects.toThrow("Video tidak valid");
	});

	test("resumable ditolak -> fallback video_url", async () => {
		const seen: string[] = [];
		__setFetchMock(async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			const method = init?.method ?? "GET";
			if (u.startsWith(`${BASE}/123/media_publish`)) {
				return jsonResponse({ body: { id: "media-9" } })
			}
			if (u.startsWith(`${BASE}/123/media`)) {
				const parsed = new URL(u);
				if (parsed.searchParams.has("video_url")) {
					seen.push("via-url");
					expect(parsed.searchParams.get("media_type")).toBe("REELS");
					return jsonResponse({ body: { id: "container-9" } })
				}
				return jsonResponse({
					body: { error: { message: "The parameter video_url is required", code: 100 } },
					status: 400,
				})
			}
			if (u.startsWith(`${BASE}/container-9`)) {
				return jsonResponse({ body: { status_code: "FINISHED" } })
			}
			if (u.startsWith(`${BASE}/media-9`)) {
				return jsonResponse({ body: { permalink: "https://ig.example/p/9" } })
			}
			expect(method).toBe("UNREACHABLE");
			return jsonResponse({ body: {} })
		});
		const stages: string[] = [];
		const result = await publishReel({
			igUserId: "123",
			accessToken: "tok",
			caption: "halo",
			videoBytes: new Uint8Array([1]).buffer,
			videoUrl: "https://cdn.example/v.mp4",
			pollIntervalMs: 1,
			onStage: (s) => stages.push(s),
		});
		expect(result).toEqual({ containerId: "container-9", permalink: "https://ig.example/p/9" });
		expect(seen).toEqual(["via-url"]);
		expect(stages).toEqual(["upload", "processing", "published"]);
	});

	test("resumable ditolak tanpa videoUrl -> error panduan", async () => {
		__setFetchMock(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.startsWith(`${BASE}/123/media`)) {
				return jsonResponse({
					body: { error: { message: "The parameter video_url is required", code: 100 } },
					status: 400,
				})
			}
			return jsonResponse({ body: {} })
		});
		await expect(
			publishReel({
				igUserId: "123",
				accessToken: "tok",
				caption: "",
				videoBytes: new Uint8Array([1]).buffer,
				pollIntervalMs: 1,
			}),
		).rejects.toThrow("KLIP_PUBLIC_BASE_URL");
	});

	test("401 menandai token invalid", async () => {
		__setFetchMock(async () =>
			jsonResponse({ body: { error: { message: "invalid", code: 190 } }, status: 401 }),
		);
		let message = "";
		try {
			await publishReel({
				igUserId: "123",
				accessToken: "basi",
				caption: "",
				videoBytes: new Uint8Array([1]).buffer,
				pollIntervalMs: 1,
			});
		} catch (e) {
			message = e instanceof Error ? e.message : "unknown";
		}
		expect(message).toContain("IG_TOKEN_INVALID");
	});
});
