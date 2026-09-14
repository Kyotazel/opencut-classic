import { chromium, type Browser, type BrowserContext } from "playwright";

/**
 * Klien Chromium untuk worker.
 *
 * KENAPA CHROMIUM
 * Kode editor (timeline, params, wasm) dirancang untuk browser. Menirunya di
 * Node berarti dua sumber kebenaran dan risiko menyimpang diam-diam - dan
 * sudah terbukti merusak jalur browser saat dicoba. Chromium adalah
 * lingkungan aslinya, jadi tidak ada yang perlu ditiru.
 *
 * Halaman /internal/batch-job mengerjakan pembuatan project memakai kode yang
 * sama dengan yang dipakai user, lalu melaporkan hasilnya lewat
 * window.__BATCH_JOB_RESULT__.
 */

export type BatchJobResult =
	| { ok: true; projectId: string }
	| { ok: false; error: string };

export type RenderProjectInput = {
	opencutRef: string;
	videoUrl: string;
	entryName: string;
};

export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;

/**
 * Sesi Chromium yang dipakai ulang antar job.
 *
 * Membuka browser per job boros (ratusan MB per instance), jadi satu browser
 * dibagi dan tiap job memakai context terpisah supaya cookie/localStorage
 * tidak bocor antar job.
 */
export class ChromiumRunner {
	private browser: Browser | null = null;
	private readonly baseUrl: string;
	private readonly username: string;
	private readonly password: string;

	constructor({
		baseUrl,
		username,
		password,
	}: {
		baseUrl: string;
		username: string;
		password: string;
	}) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.username = username;
		this.password = password;
	}

	private async ensureBrowser(): Promise<Browser> {
		if (this.browser?.isConnected()) return this.browser;
		this.browser = await chromium.launch({ headless: true });
		return this.browser;
	}

	async close(): Promise<void> {
		await this.browser?.close().catch(() => {});
		this.browser = null;
	}

	/** Context baru yang sudah login; cookie ditanam lewat API, bukan form. */
	private async newSession(): Promise<BrowserContext> {
		const browser = await this.ensureBrowser();
		const context = await browser.newContext();
		const res = await context.request.post(`${this.baseUrl}/api/auth/login`, {
			data: { username: this.username, password: this.password },
		});
		if (!res.ok()) {
			await context.close();
			throw new Error(`login worker gagal: HTTP ${res.status()}`);
		}
		return context;
	}

	/**
	 * Suruh Chromium membuat project dari satu video, memakai halaman internal.
	 * Melempar kalau halaman melaporkan gagal atau timeout.
	 */
	async renderProject({
		input,
		timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
	}: {
		input: RenderProjectInput;
		timeoutMs?: number;
	}): Promise<string> {
		const context = await this.newSession();
		try {
			const page = await context.newPage();
			const query = new URLSearchParams({
				ref: input.opencutRef,
				video: input.videoUrl,
				name: input.entryName,
			});
			const url = `${this.baseUrl}/internal/batch-job?${query.toString()}`;
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
			await page.waitForFunction(
				() => window.__BATCH_JOB_RESULT__ !== undefined,
				{ timeout: timeoutMs },
			);
			const result = (await page.evaluate(
				() => window.__BATCH_JOB_RESULT__,
			)) as BatchJobResult | undefined;
			if (!result) throw new Error("halaman tidak melaporkan hasil");
			if (!result.ok) throw new Error(result.error);
			return result.projectId;
		} finally {
			await context.close().catch(() => {});
		}
	}
}

declare global {
	interface Window {
		__BATCH_JOB_RESULT__?: BatchJobResult;
	}
}
