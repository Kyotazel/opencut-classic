import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DAYS, createSession } from "@/klip/auth-session";

const attempts = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

function rateLimited({ ip }: { ip: string }): boolean {
	const now = Date.now();
	const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
	list.push(now);
	attempts.set(ip, list);
	return list.length > MAX_ATTEMPTS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
	const appUser = process.env.APP_USER;
	const appPassword = process.env.APP_PASSWORD;
	const keyHex = process.env.APP_SESSION_KEY;
	if (!appUser || !appPassword || !keyHex) {
		return NextResponse.json({ error: "Auth belum dikonfigurasi di server" }, { status: 503 });
	}
	const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
	if (rateLimited({ ip })) {
		return NextResponse.json({ error: "Terlalu banyak percobaan. Coba lagi semenit." }, { status: 429 });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Username/password salah" }, { status: 401 });
	}
	if (!isRecord(body)) {
		return NextResponse.json({ error: "Username/password salah" }, { status: 401 });
	}
	const username = body["username"];
	const password = body["password"];
	if (typeof username !== "string" || typeof password !== "string") {
		return NextResponse.json({ error: "Username/password salah" }, { status: 401 });
	}
	if (username !== appUser || password !== appPassword) {
		return NextResponse.json({ error: "Username/password salah" }, { status: 401 });
	}
	const cookie = await createSession({ keyHex, user: appUser });
	const res = NextResponse.json({ ok: true, user: appUser });
	res.cookies.set(SESSION_COOKIE, cookie, {
		httpOnly: true,
		path: "/",
		maxAge: SESSION_DAYS * 86400,
		sameSite: "lax",
	});
	return res;
}
