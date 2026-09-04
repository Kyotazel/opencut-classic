import { describe, expect, test } from "bun:test";
import { createSession, verifySession } from "@/klip/auth-session";

const KEY = "ef".repeat(32);

describe("auth-session", () => {
	test("roundtrip valid", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo" });
		expect(await verifySession({ cookie, keyHex: KEY })).toEqual({ user: "ordo" });
	});
	test("tampered ditolak", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo" });
		expect(await verifySession({ cookie: `${cookie}x`, keyHex: KEY })).toBeNull();
	});
	test("expired ditolak", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo", daysValid: -1 });
		expect(await verifySession({ cookie, keyHex: KEY })).toBeNull();
	});
	test("key salah ditolak", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo" });
		expect(await verifySession({ cookie, keyHex: "00".repeat(32) })).toBeNull();
	});
});
