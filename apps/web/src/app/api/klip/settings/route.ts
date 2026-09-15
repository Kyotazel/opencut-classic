import { NextResponse } from "next/server";
import { SETTING_KEYS, getSettings, setSetting } from "@/klip/settings";
import { db, klipBrandTemplates, klipIgAccounts } from "@/db";

/**
 * Baca/tulis setelan default: template brand dan akun Instagram tujuan.
 *
 * KENAPA ADA: dua nilai ini dulu hanya bisa diubah lewat terminal
 * (`bun run klip:setting`). Akibatnya worker sering berhenti di tahap
 * "no_ig_account" - bukan karena error, tapi karena akun tujuannya belum
 * pernah diatur dan tidak ada cara mengaturnya dari UI.
 *
 * GET mengembalikan PILIHAN (daftar template dan akun) sekaligus nilai yang
 * sedang dipakai, supaya UI tidak perlu dua permintaan dan tidak bisa
 * menampilkan pilihan yang sudah basi.
 */

export async function GET() {
	// Urutan Promise.all harus sepadan dengan urutan destructuring: template
	// dulu, akun kedua, setelan ketiga.
	const [templates, accounts, settings] = await Promise.all([
		db.select().from(klipBrandTemplates),
		db.select().from(klipIgAccounts),
		getSettings(),
	]);
	return NextResponse.json({
		settings: {
			defaultTemplateId: settings[SETTING_KEYS.defaultTemplateId] ?? "",
			defaultIgAccountId: settings[SETTING_KEYS.defaultIgAccountId] ?? "",
			publishFailureThreshold:
				settings[SETTING_KEYS.publishFailureThreshold] ?? "2",
		},
		templates: templates.map((t) => ({ id: t.id, name: t.name })),
		accounts: accounts.map((a) => ({
			id: a.id,
			username: a.username,
			status: a.status,
		})),
	});
}

/** Hanya dua nilai ini yang boleh diubah dari endpoint ini. */
const BOLEH_DIUBAH = [
	SETTING_KEYS.defaultTemplateId,
	SETTING_KEYS.defaultIgAccountId,
	SETTING_KEYS.publishFailureThreshold,
] as const;

export async function POST(request: Request) {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400 });
	}

	for (const key of BOLEH_DIUBAH) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			return NextResponse.json(
				{ error: `${key} harus berupa teks` },
				{ status: 400 },
			);
		}
		await setSetting({ key, value: value.trim() });
	}

	const settings = await getSettings();
	return NextResponse.json({
		settings: {
			defaultTemplateId: settings[SETTING_KEYS.defaultTemplateId] ?? "",
			defaultIgAccountId: settings[SETTING_KEYS.defaultIgAccountId] ?? "",
			publishFailureThreshold:
				settings[SETTING_KEYS.publishFailureThreshold] ?? "2",
		},
	});
}
