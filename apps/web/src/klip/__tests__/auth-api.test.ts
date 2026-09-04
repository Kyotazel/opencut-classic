import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";

function req({ url, init }: { url: string; init?: RequestInit }): NextRequest {
	const r: unknown = new Request(url, init);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return r as NextRequest;
}

function reqWithCookie({ url, cookie }: { url: string; cookie: string }): NextRequest {
	const r: unknown = {
		cookies: { get: () => ({ value: cookie }) },
		nextUrl: new URL(url),
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return r as NextRequest;
}

describe("auth api", () => {
	test("tanpa env -> 503", async () => {
		delete process.env.APP_USER;
		delete process.env.APP_PASSWORD;
		delete process.env.APP_SESSION_KEY;
		const res = await login(
			req({
				url: "http://t/api/auth/login",
				init: { method: "POST", body: JSON.stringify({ username: "a", password: "b" }) },
			}),
		);
		expect(res.status).toBe(503);
	});

	test("sukses set cookie, me 200, salah password 401", async () => {
		process.env.APP_USER = "ordo";
		process.env.APP_PASSWORD = "pw-test";
		process.env.APP_SESSION_KEY = "11".repeat(32);
		const ok = await login(
			req({
				url: "http://t/api/auth/login",
				init: {
					method: "POST",
					body: JSON.stringify({ username: "ordo", password: "pw-test" }),
				},
			}),
		);
		expect(ok.status).toBe(200);
		const setCookie = ok.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("klip_session=");
		const cookie = setCookie.split(";")[0] ?? "";
		const meRes = await me(reqWithCookie({ url: "http://t/api/auth/me", cookie: decodeURIComponent(cookie.replace("klip_session=", "")) }));
		expect(meRes.status).toBe(200);
		const bad = await login(
			req({
				url: "http://t/api/auth/login",
				init: { method: "POST", body: JSON.stringify({ username: "ordo", password: "salah" }) },
			}),
		);
		expect(bad.status).toBe(401);
		const noCookie = await me(reqWithCookie({ url: "http://t/api/auth/me", cookie: "" }));
		expect(noCookie.status).toBe(401);
	});
});
