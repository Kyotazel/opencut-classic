import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipIgAccounts } from "@/db";
import { generateUUID } from "@/utils/id";
import {
	exchangeCodeForToken,
	exchangeForLongLivedToken,
	fetchIgProfile,
} from "@/klip/ig-api";
import { encryptToken } from "@/klip/ig-token";
import { absoluteUrl } from "@/utils/url";

function fail({ message, status }: { message: string; status?: number }): NextResponse {
	return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
	const params = request.nextUrl.searchParams;
	const code = params.get("code");
	const state = params.get("state");
	const expected = request.cookies.get("ig_oauth_state")?.value;
	if (!code || !state || !expected || state !== expected) {
		return fail({ message: "OAuth state tidak valid. Ulangi dari tombol Hubungkan." });
	}
	try {
		const { accessToken } = await exchangeCodeForToken(code);
		const longLived = await exchangeForLongLivedToken(accessToken);
		const profile = await fetchIgProfile(longLived.accessToken);
		const existing = await db
			.select()
			.from(klipIgAccounts)
			.where(eq(klipIgAccounts.igUserId, profile.id));
		if (existing.length > 0) {
			await db
				.update(klipIgAccounts)
				.set({
					username: profile.username,
					profilePicUrl: profile.profilePicUrl,
					accessTokenEnc: encryptToken(longLived.accessToken),
					tokenExpiresAt: new Date(Date.now() + longLived.expiresIn * 1000),
					status: "active",
					updatedAt: new Date(),
				})
				.where(eq(klipIgAccounts.igUserId, profile.id));
		} else {
			await db.insert(klipIgAccounts).values({
				id: `ig_${generateUUID().replace(/-/g, "").slice(0, 12)}`,
				igUserId: profile.id,
				username: profile.username,
				profilePicUrl: profile.profilePicUrl,
				accessTokenEnc: encryptToken(longLived.accessToken),
				tokenExpiresAt: new Date(Date.now() + longLived.expiresIn * 1000),
				status: "active",
			});
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Gagal menghubungkan akun";
		return fail({ message, status: 500 });
	}
	const res = NextResponse.redirect(
		absoluteUrl({ path: "/instagram?connected=1", requestUrl: request.url }),
	);
	res.cookies.delete("ig_oauth_state");
	return res;
}
