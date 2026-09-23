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
import { SOLANA_NAMESPACE } from "@nihilium/recovery-key-solana";
import { parseHardenedPath } from "@nihilium-demo/keys";
import {
    createRoleIdentity,
    ROLE_CHAINS,
    type RoleIdentityOptions,
} from "../src/roleIdentity.js";

const SEPOLIA = "eip155:11155111";
const SOLANA = SOLANA_NAMESPACE.devnet;
/**
 * A fixed phrase, declared here rather than imported.
 *
 * These vectors pin derivation, so it has to be constant — and the server no longer ships one:
 * `ROLE_MNEMONIC` is required and generated per machine, because the published phrase it used to
 * fall back to derives addresses anyone can reach. This is that phrase, used as an input to the
 * arithmetic and never as a key that holds anything.
 */
const FIXTURE_MNEMONIC = "test test test test test test test test test test test junk";

const options: RoleIdentityOptions = { mnemonic: FIXTURE_MNEMONIC, supplied: {} };

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
        // `solana:devnet` reads like a chain id and is not one — CAIP-2 for Solana is the truncated
        // genesis hash. Since the namespace is a KDF input, a hand-written one has to fail here
        // rather than derive a perfectly valid key for a chain that does not exist.
        expect(() => createRoleIdentity("pause", 1, options).on("solana:devnet")).toThrow(
            /No role key scheme/,
        );
    });
});

describe("role identities on Solana", () => {
    it("derives on ed25519, not secp256k1", () => {
        const key = createRoleIdentity("relayer", 0, options).on(SOLANA);
        expect(key.publicKey.algorithm).toBe("ed25519");
        expect(key.publicKey.bytes).toHaveLength(32);
        expect(key.authority.namespace).toBe(SOLANA);
    });

    it("pins the relayer's devnet address", () => {
        // A regression pin, not an external truth: it says derivation has not moved. Every role
        // address is something an operator funds once, and a silent change strands the balance.
        expect(createRoleIdentity("relayer", 0, options).on(SOLANA).authority.id).toBe(
            "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD",
        );
    });

    it("gives one role different keys on different chains", () => {
        // The premise of this file: a role is a party, not a key. The same party on two chains is
        // two key pairs, and conflating them is impossible because the curves differ.
        const relayer = createRoleIdentity("relayer", 0, options);
        expect(relayer.on(SOLANA).authority.id).not.toBe(relayer.on(SEPOLIA).authority.id);
    });

    it("uses a fully hardened path, because SLIP-0010 defines nothing else", () => {
        const path = ROLE_CHAINS[SOLANA]!.path(0);
        expect(path).toBe("m/44'/501'/1'/0'");
        // Would throw on any unhardened segment. The failure has to be here rather than at an
        // address nobody funded.
        expect(() => parseHardenedPath(path)).not.toThrow();
    });

    it("keeps role keys off the wallet's own branch", () => {
        // `1'` where the wallet uses `0'`, the same separation the EVM path makes.
        expect(ROLE_CHAINS[SOLANA]!.path(0)).not.toContain("/501'/0'/");
    });

    it("refuses a raw key for a curve it cannot identify", () => {
        // One key slot per role, not per role and chain — and 32 bytes is a valid seed on either
        // curve, so guessing yields a key for an account nobody named.
        expect(() =>
            createRoleIdentity("relayer", 0, {
                ...options,
                supplied: { relayer: `0x${"11".repeat(32)}` },
            }).on(SOLANA),
        ).toThrow(/cannot tell which chain/);
    });
});
