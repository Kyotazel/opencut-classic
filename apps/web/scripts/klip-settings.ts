/**
 * Alat bantu setelan batch (window render, template default, dll).
 *
 * KENAPA ADA: tabel klip_settings belum punya UI, dan mengubahnya lewat SQL
 * mentah mudah salah - kolom updated_at tidak punya nilai default di database
 * (drizzle mengisinya dari aplikasi), sehingga INSERT langsung gagal dengan
 * "Field 'updated_at' doesn't have a default value".
 *
 * PAKAI:
 *   bun run klip:setting                      # tampilkan semua
 *   bun run klip:setting window 11:00 15:00   # aktifkan window
 *   bun run klip:setting window off           # matikan window
 *   bun run klip:setting allow-manual on|off
 *   bun run klip:setting template <id|none>
 *   bun run klip:setting ig-account <id|none>     # akun IG tujuan publish
 *   bun run klip:setting publish-threshold <n>    # kegagalan berturut -> hentikan
 */
import {
	resolveBatchSettings,
	SETTING_KEYS,
	setSetting,
	getSettings,
} from "@/klip/settings";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function fmtTime({ value }: { value: string }): string {
	return HHMM.test(value.trim()) ? value.trim() : `${value.trim()} (tidak valid!)`;
}

async function show(): Promise<void> {
	const raw = await getSettings();
	const r = await resolveBatchSettings();
	console.log("--- setelan batch ---");
	console.log(`window           : ${r.windowEnabled ? "AKTIF" : "mati"}`);
	console.log(`  mulai          : ${fmtTime({ value: raw[SETTING_KEYS.renderWindowStart] })}`);
	console.log(`  selesai        : ${fmtTime({ value: raw[SETTING_KEYS.renderWindowEnd] })}`);
	console.log(`boleh jalan manual: ${r.allowManualRun ? "ya" : "tidak"}`);
	console.log(`template default : ${r.defaultTemplateId ?? "(tidak ada)"}`);
	console.log(`akun IG default  : ${r.defaultIgAccountId ?? "(tidak ada)"}`);
	console.log(`ambang hentikan  : ${r.publishFailureThreshold} kegagalan`);
	console.log("");
	if (!r.windowEnabled) {
		console.log("Window mati: worker langsung mengerjakan setiap job yang masuk.");
	} else if (!r.windowStart || !r.windowEnd) {
		console.log("PERINGATAN: jam window tidak valid; worker menganggap selalu terbuka.");
	}
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);

	if (!cmd) {
		await show();
		return;
	}

	if (cmd === "window") {
		const [a, b] = rest;
		if (a === "off") {
			await setSetting({ key: SETTING_KEYS.renderWindowEnabled, value: "0" });
			console.log("Window dimatikan: worker jalan kapan saja.");
		} else if (a && b && HHMM.test(a) && HHMM.test(b)) {
			await setSetting({ key: SETTING_KEYS.renderWindowStart, value: a });
			await setSetting({ key: SETTING_KEYS.renderWindowEnd, value: b });
			await setSetting({ key: SETTING_KEYS.renderWindowEnabled, value: "1" });
			console.log(`Window aktif: ${a}-${b}. Di luar itu worker menunggu.`);
		} else {
			throw new Error("pakai: window <HH:MM> <HH:MM>  atau  window off");
		}
	} else if (cmd === "allow-manual") {
		const v = rest[0];
		if (v !== "on" && v !== "off") throw new Error("pakai: allow-manual on|off");
		await setSetting({
			key: SETTING_KEYS.allowManualRun,
			value: v === "on" ? "1" : "0",
		});
		console.log(`Jalan manual (--now): ${v === "on" ? "diizinkan" : "dilarang"}.`);
	} else if (cmd === "template") {
		const v = rest[0];
		if (!v) throw new Error("pakai: template <id>  atau  template none");
		await setSetting({
			key: SETTING_KEYS.defaultTemplateId,
			value: v === "none" ? "" : v,
		});
		console.log(`Template default: ${v === "none" ? "(dihapus)" : v}`);
	} else if (cmd === "ig-account") {
		const v = rest[0];
		if (!v) throw new Error("pakai: ig-account <id>  atau  ig-account none");
		await setSetting({
			key: SETTING_KEYS.defaultIgAccountId,
			value: v === "none" ? "" : v,
		});
		console.log(`Akun IG default: ${v === "none" ? "(dihapus)" : v}`);
	} else if (cmd === "publish-threshold") {
		const v = rest[0];
		const n = Number(v);
		if (!v || !Number.isInteger(n) || n < 1 || n > 20) {
			throw new Error("pakai: publish-threshold <1-20>");
		}
		await setSetting({
			key: SETTING_KEYS.publishFailureThreshold,
			value: String(n),
		});
		console.log(
			`Ambang hentikan: ${n} kegagalan publish berturut-turut mematikan batch.`,
		);
	} else {
		throw new Error(`perintah tidak dikenal: ${cmd}`);
	}

	console.log("");
	await show();
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
