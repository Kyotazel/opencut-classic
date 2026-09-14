import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright";

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
	/** Template yang ditempel setelah project dibuat; kosong = tanpa template. */
	templateId?: string | null;
	/** Kalau diisi, halaman ikut merender MP4 dan mengunggahnya. */
	batchId: string;
	jobId: string;
};

/**
 * Batas tunggu satu job, termasuk render.
 *
 * Render memakan sekitar 3,3x durasi video (diukur: 24,9 dtk -> 81 dtk). Video
 * 60 detik berarti ~200 detik render, ditambah ekstraksi video dan pembuatan
 * project. 30 menit memberi ruang cukup untuk video panjang tanpa membuat
 * worker menggantung selamanya kalau halaman benar-benar macet.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;

/**
 * Teruskan console, error halaman, dan permintaan yang gagal ke log worker.
 *
 * KENAPA INI ADA: kegagalan render hanya dilaporkan ke worker sebagai SATU
 * baris pesan (`result.error`), sedangkan penjelasan lengkapnya - termasuk
 * stack trace - hanya pernah ditulis ke console halaman, lalu ikut hilang saat
 * halamannya ditutup. Akibatnya kegagalan seperti "network error" tidak bisa
 * didiagnosis sama sekali: pesannya generik dan asalnya tidak diketahui.
 *
 * Dengan ini log pm2 menyimpan sebab yang sebenarnya, dan permintaan HTTP yang
 * gagal (mis. pengambilan video atau unggahan hasil) ikut tercatat berikut kode
 * kesalahannya - bukan cuma gejalanya.
 */
function forwardPageDiagnostics({
	page,
	label,
}: {
	page: Page;
	label: string;
}): void {
	page.on("console", (message) => {
		const type = message.type();
		if (type !== "error" && type !== "warning") return;
		void Promise.all(
			message.args().map((arg) =>
				arg
					.evaluate((value: unknown) => {
						if (value instanceof Error) {
							return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
						}
						if (typeof value === "string") return value;
						try {
							return JSON.stringify(value);
						} catch {
							return String(value);
						}
					})
					.catch(() => "<argumen tidak terbaca>"),
			),
		)
			.then((parts) => {
				console.error(`[chromium:${type}] ${label} ${parts.join(" ")}`);
			})
			.catch(() => {
				// Diagnostik tidak boleh menjatuhkan job.
			});
	});

	page.on("pageerror", (error) => {
		console.error(
			`[chromium:pageerror] ${label} ${error.name}: ${error.message}\n${error.stack ?? ""}`,
		);
	});

	page.on("requestfailed", (request) => {
		const failure = request.failure()?.errorText ?? "tidak diketahui";
		// ERR_ABORTED muncul wajar saat halaman ditutup; bukan kegagalan nyata.
		if (failure.includes("ERR_ABORTED")) return;
		console.error(
			`[chromium:requestfailed] ${label} ${request.method()} ${request.url()} - ${failure}`,
		);
	});
}

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
	private context: BrowserContext | null = null;

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
		await this.context?.close().catch(() => {});
		this.context = null;
		await this.browser?.close().catch(() => {});
		this.browser = null;
	}

	/**
	 * Satu context yang sudah login, dipakai ulang untuk SEMUA job.
	 *
	 * KENAPA TIDAK LOGIN PER JOB
	 * /api/auth/login dibatasi 10 percobaan per menit per IP. Kalau tiap job
	 * membuat sesi baru, batch ke-11 selalu gagal dengan HTTP 429 - dan itu
	 * terjadi walaupun pemrosesan berjalan normal.
	 *
	 * Aman dipakai bersama karena job diproses SERIAL (bukan paralel) dan tiap
	 * project punya id unik, sehingga kunci penyimpanan browser tidak bentrok.
	 */
	private async ensureSession(): Promise<BrowserContext> {
		if (this.context) return this.context;
		const browser = await this.ensureBrowser();
		const context = await browser.newContext();
		const res = await context.request.post(`${this.baseUrl}/api/auth/login`, {
			data: { username: this.username, password: this.password },
		});
		if (!res.ok()) {
			await context.close();
			throw new Error(`login worker gagal: HTTP ${res.status()}`);
		}
		this.context = context;
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
		const context = await this.ensureSession();
		const page = await context.newPage();
		forwardPageDiagnostics({ page, label: input.jobId });
		try {
			const query = new URLSearchParams({
				ref: input.opencutRef,
				video: input.videoUrl,
				name: input.entryName,
			});
			if (input.templateId) query.set("template", input.templateId);
			// batch + job membuat halaman ikut merender dan mengunggah hasilnya.
			query.set("batch", input.batchId);
			query.set("job", input.jobId);
			const url = `${this.baseUrl}/internal/batch-job?${query.toString()}`;
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
			// PERHATIKAN tanda tangannya: waitForFunction(fn, arg, options).
			// Memberi options sebagai argumen KEDUA membuatnya dianggap "arg" dan
			// timeout tetap default 30 detik - render yang butuh menit akan selalu
			// gagal walau batasnya sudah dinaikkan.
			await page.waitForFunction(
				() => window.__BATCH_JOB_RESULT__ !== undefined,
				undefined,
				{ timeout: timeoutMs },
			);
			const result = (await page.evaluate(
				() => window.__BATCH_JOB_RESULT__,
			)) as BatchJobResult | undefined;
			if (!result) throw new Error("halaman tidak melaporkan hasil");
			if (!result.ok) throw new Error(result.error);
			return result.projectId;
		} finally {
			// Halaman ditutup per job, tetapi CONTEXT-nya tidak: sesi login dipakai
			// ulang supaya tidak menabrak batas 10 login/menit.
			await page.close().catch(() => {});
		}
	}
}

declare global {
	interface Window {
		__BATCH_JOB_RESULT__?: BatchJobResult;
	}
}
