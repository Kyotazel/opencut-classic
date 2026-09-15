import { beforeEach, describe, expect, test } from "bun:test";
import {
	__lupakanPemakaianKuota,
	__setFetchMock,
	pemakaianKuotaTerakhir,
	publishReel,
} from "@/klip/ig-api";

function jsonResponse({
	body,
	status,
	headers,
}: {
	body: unknown;
	status?: number;
	headers?: Record<string, string>;
}): Response {
	return new Response(JSON.stringify(body), {
		status: status ?? 200,
		headers: { "content-type": "application/json", ...(headers ?? {}) },
	});
}

const BASE = "https://graph.instagram.com/v26.0";

/**
 * Pemakaian kuota Instagram dibaca dari header respons.
 *
 * KENAPA PENTING: kuota panggilan Instagram dihitung per 24 jam sebagai
 * 4800 * jumlah penayangan, jadi akun testing punya kuota kecil. Tanpa membaca
 * angka ini kita baru tahu kuota habis SETELAH menabraknya - dan tiap
 * percobaan yang gagal tetap menghabiskan sisa kuota.
 */
function pasangMock({ header }: { header: Record<string, string> }): void {
	__setFetchMock(async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url);
		// media_publish diperiksa SEBELUM media: "/123/media" juga merupakan
		// awalan dari "/123/media_publish".
		if (u.startsWith(`${BASE}/123/media_publish`)) {
			return jsonResponse({ body: { id: "MEDIA" } });
		}
		if (u.startsWith(`${BASE}/123/media`) && (init?.method ?? "GET") === "POST") {
			return jsonResponse({
				body: { id: "container-1", uri: "https://rupload.example/container-1" },
				headers: header,
			});
		}
		if (u.startsWith("https://rupload.example/")) return new Response(null, { status: 200 });
		if (u.startsWith(`${BASE}/container-1`)) {
			return jsonResponse({ body: { status_code: "FINISHED" } });
		}
		if (u.startsWith(`${BASE}/MEDIA`)) {
			return jsonResponse({ body: { permalink: "https://ig.example/p/1" } });
		}
		return jsonResponse({ body: {}, status: 404 });
	});
}

async function jalankan(): Promise<void> {
	await publishReel({
		igUserId: "123",
		accessToken: "tok",
		caption: "",
		videoBytes: new Uint8Array([1]).buffer,
		pollIntervalMs: 1,
	});
}

describe("pemakaian kuota Instagram", () => {
	beforeEach(() => {
		// Nilai pemakaian hidup di tingkat modul; tanpa reset, hasil satu tes
		// membocor ke tes berikutnya.
		__lupakanPemakaianKuota();
		__setFetchMock(async () => jsonResponse({ body: {} }));
	});

	test("header X-App-Usage dibaca", async () => {
		pasangMock({
			header: { "x-app-usage": JSON.stringify({ call_count: 42, total_cputime: 11 }) },
		});
		await jalankan();
		expect(pemakaianKuotaTerakhir()).toBe(42);
	});

	test("header X-Business-Use-Case-Usage berbentuk map dibaca", async () => {
		pasangMock({
			header: {
				"x-business-use-case-usage": JSON.stringify({
					"17841400000000000": [
						{ call_count: 93, total_cputime: 5, total_time: 7, type: "instagram" },
					],
				}),
			},
		});
		await jalankan();
		// Nilai tertinggi dari seluruh kolom yang dilaporkan.
		expect(pemakaianKuotaTerakhir()).toBe(93);
	});

	test("header rusak tidak menggagalkan permintaan", async () => {
		pasangMock({ header: { "x-app-usage": "bukan json" } });
		await jalankan();
		expect(pemakaianKuotaTerakhir()).toBeNull();
	});
});
