import { inArray } from "drizzle-orm";
import { db, klipSettings } from "@/db";

/**
 * Setting key-value (keputusan bagian 9 #2 dokumen rencana).
 *
 * Nilai disimpan sebagai teks TANPA tipe dari database, jadi setiap key
 * WAJIB punya pembaca sendiri di sini. Jangan parsing manual di route —
 * itu persis cara "15:0" lolos jadi jam yang tidak valid.
 */

export const SETTING_KEYS = {
	renderWindowEnabled: "render_window_enabled",
	renderWindowStart: "render_window_start",
	renderWindowEnd: "render_window_end",
	allowManualRun: "allow_manual_run",
	defaultTemplateId: "default_template_id",
	defaultIgAccountId: "default_ig_account_id",
	publishFailureThreshold: "publish_failure_threshold",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export const SETTING_DEFAULTS: Record<SettingKey, string> = {
	[SETTING_KEYS.renderWindowEnabled]: "0",
	[SETTING_KEYS.renderWindowStart]: "11:00",
	[SETTING_KEYS.renderWindowEnd]: "15:00",
	[SETTING_KEYS.allowManualRun]: "1",
	[SETTING_KEYS.defaultTemplateId]: "",
	[SETTING_KEYS.defaultIgAccountId]: "",
	[SETTING_KEYS.publishFailureThreshold]: "2",
};

export const DEFAULT_PUBLISH_FAILURE_THRESHOLD = 2;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Baca banyak key sekaligus; key yang tidak ada jatuh ke default. */
export async function getSettings(): Promise<Record<SettingKey, string>> {
	const rows = await db.select().from(klipSettings);
	const found = new Map(rows.map((r) => [r.key, r.value]));
	const out = { ...SETTING_DEFAULTS };
	for (const key of Object.values(SETTING_KEYS)) {
		const value = found.get(key);
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

export async function getSetting({ key }: { key: SettingKey }): Promise<string> {
	const rows = await db
		.select()
		.from(klipSettings)
		.where(inArray(klipSettings.key, [key]))
		.limit(1);
	return rows[0]?.value ?? SETTING_DEFAULTS[key];
}

export async function setSetting({
	key,
	value,
}: {
	key: SettingKey;
	value: string;
}): Promise<void> {
	await db
		.insert(klipSettings)
		.values({ key, value })
		.onDuplicateKeyUpdate({ set: { value, updatedAt: new Date() } });
}

/** "1"/"true"/"yes"/"on" dianggap benar; selain itu salah. */
export function parseBoolSetting({ value }: { value: string }): boolean {
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * "HH:MM" 24 jam. Mengembalikan null kalau tidak valid supaya pemanggil
 * memutuskan — jangan diam-diam jatuh ke default, itu menyembunyikan salah ketik.
 */
export function parseTimeSetting({ value }: { value: string }): { hour: number; minute: number } | null {
	const m = HHMM.exec(value.trim());
	if (!m) return null;
	return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function parseCountSetting({
	value,
	fallback,
}: {
	value: string;
	fallback: number;
}): number {
	const n = Number(value.trim());
	if (!Number.isInteger(n) || n < 1) return fallback;
	return n;
}

/** Nilai yang dipakai worker; sudah tervalidasi. */
export type ResolvedBatchSettings = {
	windowEnabled: boolean;
	windowStart: { hour: number; minute: number } | null;
	windowEnd: { hour: number; minute: number } | null;
	allowManualRun: boolean;
	defaultTemplateId: string | null;
	defaultIgAccountId: string | null;
	publishFailureThreshold: number;
};

export async function resolveBatchSettings(): Promise<ResolvedBatchSettings> {
	const s = await getSettings();
	return {
		windowEnabled: parseBoolSetting({ value: s[SETTING_KEYS.renderWindowEnabled] }),
		windowStart: parseTimeSetting({ value: s[SETTING_KEYS.renderWindowStart] }),
		windowEnd: parseTimeSetting({ value: s[SETTING_KEYS.renderWindowEnd] }),
		allowManualRun: parseBoolSetting({ value: s[SETTING_KEYS.allowManualRun] }),
		defaultTemplateId: s[SETTING_KEYS.defaultTemplateId].trim() || null,
		defaultIgAccountId: s[SETTING_KEYS.defaultIgAccountId].trim() || null,
		publishFailureThreshold: parseCountSetting({
			value: s[SETTING_KEYS.publishFailureThreshold],
			fallback: DEFAULT_PUBLISH_FAILURE_THRESHOLD,
		}),
	};
}
