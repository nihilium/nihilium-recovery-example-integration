/**
 * The role identities are the demo's most load-bearing shortcut, so what makes them safe to ship is
 * pinned here: they are stable (fund them once), they are distinct (the veto's whole design is that
 * no party holds two), and a per-role override really does override.
 *
 * The last two tests are about the *next* chain rather than this one — they pin that an unwired
 * chain and a wrong-curve key both fail loudly, because both are silent-wrong-key failures
 * otherwise.
 */
import { describe, expect, it } from "vitest";
import {
    createRoleIdentity,
    DEMO_ROLE_MNEMONIC,
    ROLE_CHAINS,
    type RoleIdentityOptions,
} from "../src/roleIdentity.js";

const SEPOLIA = "eip155:11155111";
const options: RoleIdentityOptions = { mnemonic: DEMO_ROLE_MNEMONIC, supplied: {} };

describe("role identities", () => {
    it("derives the same authority every boot", () => {
        const once = createRoleIdentity("pause", 1, options).on(SEPOLIA);
        const twice = createRoleIdentity("pause", 1, options).on(SEPOLIA);
        expect(once.authority).toEqual(twice.authority);
        expect(once.authority.namespace).toBe(SEPOLIA);
    });

    it("gives every role a different key", () => {
        const ids = [
            createRoleIdentity("relayer", 0, options),
            createRoleIdentity("pause", 1, options),
            createRoleIdentity("abort", 2, options),
            createRoleIdentity("resume-1", 10, options),
            createRoleIdentity("resume-2", 11, options),
            createRoleIdentity("resume-3", 12, options),
        ];
        const addresses = ids.map((id) => id.on(SEPOLIA).authority.id);
        expect(new Set(addresses).size).toBe(addresses.length);
    });

    it("keeps role keys off the wallet's own branch", () => {
        // `1'` where a wallet uses `0'`: a role key must never be an account the demo is showing.
        expect(ROLE_CHAINS[SEPOLIA]!.path(0)).toBe("m/44'/60'/1'/0/0");
    });

    it("prefers a supplied key, and says it was supplied", () => {
        const supplied = `0x${"11".repeat(32)}`;
        const key = createRoleIdentity("abort", 2, { ...options, supplied: { abort: supplied } }).on(
            SEPOLIA,
        );
        expect(key.supplied).toBe(true);
        expect(key.privateKey).toBe(supplied);
        expect(key.authority.id).not.toBe(createRoleIdentity("abort", 2, options).on(SEPOLIA).authority.id);
    });

    it("refuses a malformed key rather than falling back to a derived one", () => {
        // Falling back would start a server whose abort authority is not the key the operator set:
        // configured wrongly, and looking configured.
        expect(() => createRoleIdentity("abort", 2, { ...options, supplied: { abort: "0xnope" } })).toThrow(
            /hex private key/,
        );
    });

    it("refuses a mnemonic that is not one", () => {
        expect(() =>
            createRoleIdentity("pause", 1, { mnemonic: "not a real phrase", supplied: {} }).on(SEPOLIA),
        ).toThrow(/ROLE_MNEMONIC/);
    });

    it("refuses a chain no role has a scheme for", () => {
        expect(() => createRoleIdentity("pause", 1, options).on("solana:devnet")).toThrow(
            /No role key scheme/,
        );
    });
});
