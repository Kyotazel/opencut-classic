// Helper session cookie HMAC. Isomorphic: hanya WebCrypto agar bisa dipakai
// middleware Edge (node:crypto tidak tersedia di Edge).
export const SESSION_COOKIE = "klip_session";
export const SESSION_DAYS = 30;

async function hmacKey({ keyHex }: { keyHex: string }): Promise<CryptoKey> {
	const raw = Uint8Array.from(Buffer.from(keyHex, "hex"));
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

function toHex({ bytes }: { bytes: ArrayBuffer }): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex({ hex }: { hex: string }): Uint8Array | null {
	if (!/^[0-9a-f]{2,}$/.test(hex) || hex.length % 2 !== 0) return null;
	return Uint8Array.from(Buffer.from(hex, "hex"));
}

export async function createSession({
	keyHex,
	user,
	daysValid,
}: {
	keyHex: string;
	user: string;
	daysValid?: number;
}): Promise<string> {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(user)) {
		throw new Error("Username session tidak valid");
	}
	const expiry = Date.now() + (daysValid ?? SESSION_DAYS) * 86400 * 1000;
	const payload = `${user}:${expiry}`;
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey({ keyHex }),
		new TextEncoder().encode(payload),
	);
	return `${payload}.${toHex({ bytes: sig })}`;
}

export async function verifySession({
	cookie,
	keyHex,
}: {
	cookie: string;
	keyHex: string;
}): Promise<{ user: string } | null> {
	const dot = cookie.lastIndexOf(".");
	if (dot < 0) return null;
	const payload = cookie.slice(0, dot);
	const sep = payload.indexOf(":");
	if (sep < 0) return null;
	const user = payload.slice(0, sep);
	const expiry = Number(payload.slice(sep + 1));
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(user)) return null;
	if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
	const sig = fromHex({ hex: cookie.slice(dot + 1) });
	if (!sig) return null;
	const expected = await crypto.subtle.sign(
		"HMAC",
		await hmacKey({ keyHex }),
		new TextEncoder().encode(payload),
	);
	const a = new Uint8Array(expected);
	if (a.length !== sig.length) return null;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= (a[i] ?? 0) ^ (sig[i] ?? 0);
	}
	return diff === 0 ? { user } : null;
}
