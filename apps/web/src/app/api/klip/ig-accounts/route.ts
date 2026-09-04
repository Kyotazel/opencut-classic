import { NextResponse } from "next/server";
import { db, klipIgAccounts } from "@/db";

export async function GET() {
	const rows = await db.select().from(klipIgAccounts);
	return NextResponse.json({
		accounts: rows.map((r) => ({
			id: r.id,
			igUserId: r.igUserId,
			username: r.username,
			profilePicUrl: r.profilePicUrl,
			status: r.status,
			tokenExpiresAt: r.tokenExpiresAt,
		})),
	});
}
