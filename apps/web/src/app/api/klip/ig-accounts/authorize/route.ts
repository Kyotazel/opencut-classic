import { NextResponse } from "next/server";
import { generateUUID } from "@/utils/id";
import { buildAuthorizeUrl } from "@/klip/ig-api";

export async function GET() {
	let url: string;
	try {
		const state = generateUUID().replace(/-/g, "");
		url = buildAuthorizeUrl(state);
		const res = NextResponse.redirect(url);
		res.cookies.set("ig_oauth_state", state, {
			httpOnly: true,
			path: "/",
			maxAge: 600,
			sameSite: "lax",
		});
		return res;
	} catch (error) {
		const message = error instanceof Error ? error.message : "OAuth gagal dimulai";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
