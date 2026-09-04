import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipIgAccounts } from "@/db";

// eslint-disable-next-line opencut/prefer-object-params
export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const rows = await db
		.select()
		.from(klipIgAccounts)
		.where(eq(klipIgAccounts.id, id));
	if (rows.length === 0) {
		return NextResponse.json({ error: "Akun tidak ditemukan" }, { status: 404 });
	}
	await db
		.update(klipIgAccounts)
		.set({ status: "disconnected", updatedAt: new Date() })
		.where(eq(klipIgAccounts.id, id));
	return NextResponse.json({ ok: true });
}
