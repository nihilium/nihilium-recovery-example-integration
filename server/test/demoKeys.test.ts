/**
 * The role keys are the demo's most load-bearing shortcut, so the two things that make them safe to
 * ship are pinned here: they are stable (fund them once), and they are distinct (the veto's whole
 * design is that no one party holds two of these).
 */
import { describe, expect, it } from "vitest";
import { addressOf, roleKey } from "../src/demoKeys.js";

describe("demo role keys", () => {
    it("derives the same address every boot", () => {
        expect(addressOf(roleKey("pause", undefined, 1))).toBe(
            addressOf(roleKey("pause", undefined, 1)),
        );
    });

    it("gives every role a different key", () => {
        const addresses = [0, 1, 2, 10, 11, 12].map((i) => addressOf(roleKey("relayer", undefined, i)));
        expect(new Set(addresses).size).toBe(addresses.length);
    });

    it("prefers a supplied key and records that it was supplied", () => {
        const supplied = `0x${"11".repeat(32)}`;
        const key = roleKey("abort", supplied, 2);
        expect(key.supplied).toBe(true);
        expect(key.privateKey).toBe(supplied);
        expect(addressOf(key)).not.toBe(addressOf(roleKey("abort", undefined, 2)));
    });

    it("refuses a malformed key rather than falling back to a derived one", () => {
        // Falling back here would start a server whose pause authority is not the key the operator
        // set — configured wrongly, and looking configured.
        expect(() => roleKey("pause", "0xnope", 1)).toThrow(/hex private key/);
    });
});
