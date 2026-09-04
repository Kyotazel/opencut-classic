import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
	const hex = process.env.IG_TOKEN_KEY;
	if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(
			"IG_TOKEN_KEY belum dipasang (butuh 32 byte hex di env server)",
		);
	}
	return Buffer.from(hex, "hex");
}

export function encryptToken(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key(), iv);
	const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return `${iv.toString("hex")}:${enc.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

export function decryptToken(payload: string): string {
	const [ivHex, encHex, tagHex] = payload.split(":");
	if (!ivHex || !encHex || !tagHex) {
		throw new Error("Format token terenkripsi tidak valid");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key(),
		Buffer.from(ivHex, "hex"),
	);
	decipher.setAuthTag(Buffer.from(tagHex, "hex"));
	return Buffer.concat([
		decipher.update(Buffer.from(encHex, "hex")),
		decipher.final(),
	]).toString("utf8");
}
