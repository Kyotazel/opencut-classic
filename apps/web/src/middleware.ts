import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/klip/auth-session";
import { SIGNATURE_HEADER, bolehLewatLogin } from "@/klip/machine-auth";
import { absoluteUrl } from "@/utils/url";

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};

async function hasSession({ request }: { request: NextRequest }): Promise<boolean> {
	const keyHex = process.env.APP_SESSION_KEY;
	if (!keyHex) return false;
	const cookie = request.cookies.get(SESSION_COOKIE)?.value;
	if (!cookie) return false;
	try {
		return (await verifySession({ cookie, keyHex })) !== null;
	} catch {
		return false;
	}
}

export async function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (pathname === "/") return NextResponse.next();
	if (pathname === "/api/auth/login") return NextResponse.next();
	if (pathname.startsWith("/api/klip/publishes/") && pathname.endsWith("/video")) {
		return NextResponse.next();
	}
	if (!process.env.APP_SESSION_KEY || !process.env.APP_USER || !process.env.APP_PASSWORD) {
		if (pathname.startsWith("/api/")) {
			return NextResponse.json({ error: "Auth belum dikonfigurasi di server" }, { status: 503 });
		}
		return NextResponse.redirect(
			absoluteUrl({ path: "/", requestUrl: request.url }),
		);
	}
	// Pengirim mesin (OpenShorts) membawa tanda tangan, bukan cookie. Aturannya
	// ada di machine-auth.ts supaya bisa diuji tanpa menjalankan Edge runtime.
	if (
		bolehLewatLogin({
			pathname,
			header: request.headers.get(SIGNATURE_HEADER),
			secret: process.env.KLIP_WEBHOOK_SECRET,
		})
	) {
		return NextResponse.next();
	}
	if (await hasSession({ request })) return NextResponse.next();
	if (pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	return NextResponse.redirect(absoluteUrl({ path: "/", requestUrl: request.url }));
}
