import { NextResponse } from "next/server";
import { db, klipSyncProjects } from "@/db";

export async function GET() {
	const rows = await db.select().from(klipSyncProjects);
	return NextResponse.json({
		projects: rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt })),
	});
}
