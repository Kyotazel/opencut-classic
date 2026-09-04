import { describe, expect, test } from "bun:test";
import { decryptToken, encryptToken } from "@/klip/ig-token";

describe("ig-token", () => {
	test("roundtrip", () => {
		process.env.IG_TOKEN_KEY = "ab".repeat(32);
		const enc = encryptToken("token-rahasia-123");
		expect(enc).not.toContain("token-rahasia-123");
		expect(decryptToken(enc)).toBe("token-rahasia-123");
	});
	test("dua enkripsi menghasilkan ciphertext berbeda (IV acak)", () => {
		process.env.IG_TOKEN_KEY = "ab".repeat(32);
		expect(encryptToken("sama")).not.toBe(encryptToken("sama"));
	});
	test("tanpa key meledak dengan pesan jelas", () => {
		delete process.env.IG_TOKEN_KEY;
		expect(() => encryptToken("x")).toThrow("IG_TOKEN_KEY");
	});
});
