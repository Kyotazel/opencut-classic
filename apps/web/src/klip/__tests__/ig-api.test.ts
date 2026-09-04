import { beforeEach, describe, expect, test } from "bun:test";
import { __setFetchMock, publishReel } from "@/klip/ig-api";

function jsonResponse({ body, status }: { body: unknown; status?: number }): Response {
	return new Response(JSON.stringify(body), {
		status: status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

const BASE = "https://graph.instagram.com/v24.0";

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
			if (u.startsWith(`${BASE}/123/video`)) {
				return jsonResponse({ body: { upload_url: "https://upload.example/v1" } })
			}
			if (u.startsWith("https://upload.example/")) {
				expect(method).toBe("PUT");
				return jsonResponse({ body: { success: true } })
			}
			if (u.startsWith(`${BASE}/123/media_publish`)) {
				return jsonResponse({ body: { id: "media-9" } })
			}
			if (u.startsWith(`${BASE}/123/media`)) {
				return jsonResponse({ body: { id: "container-1" } })
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
			videoBytes: new Uint8Array([1, 2, 3]),
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
			if (u.includes("/123/video")) return jsonResponse({ body: { upload_url: "https://upload.example/v1" } })
			if (u.startsWith("https://upload.example/")) return jsonResponse({ body: { success: true } })
			if (u.includes("/123/media")) return jsonResponse({ body: { id: "container-2" } })
			return jsonResponse({ body: { status_code: "ERROR", status: "Video tidak valid" } })
		});
		await expect(
			publishReel({
				igUserId: "123",
				accessToken: "tok",
				caption: "",
				videoBytes: new Uint8Array([1]),
				pollIntervalMs: 1,
			}),
		).rejects.toThrow("Video tidak valid");
	});

	test("401 menandai token invalid", async () => {
		__setFetchMock(async () =>
			jsonResponse({ body: { error: { message: "invalid", code: 190 } }, status: 401 }),
		);
		const err = await publishReel({
			igUserId: "123",
			accessToken: "basi",
			caption: "",
			videoBytes: new Uint8Array([1]),
			pollIntervalMs: 1,
		}).catch((e: Error) => e);
		expect(err.message).toContain("IG_TOKEN_INVALID");
	});
});
