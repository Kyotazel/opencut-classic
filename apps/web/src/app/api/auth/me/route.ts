import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/klip/auth-session";

export async function GET(request: NextRequest) {
	const keyHex = process.env.APP_SESSION_KEY;
	const cookie = request.cookies.get(SESSION_COOKIE)?.value;
	if (!keyHex || !cookie) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	try {
		const session = await verifySession({ cookie, keyHex });
		if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		return NextResponse.json({ user: session.user });
	} catch {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
}
