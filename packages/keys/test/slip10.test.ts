/**
 * SLIP-0010, pinned against the specification's own vectors.
 *
 * These are **externally verifiable**, which is the reason they moved here with the scheme: if they
 * break, this package is wrong, and that verdict does not depend on anything either consumer does.
 * The app's `keys.test.ts` keeps the regression pins — the addresses this repo happens to produce
 * at its own paths — because those say "this has not changed", not "this is right".
 *
 * Why pin at all: every key derived here ends up as a `ChainContext.accountId` or a role's on-chain
 * identity. A silent change re-derives every recovery key in the demo.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { slip10Ed25519, parseHardenedPath, UnhardenedPathError } from "../src/index.js";

describe("SLIP-0010 ed25519 — published test vector 1", () => {
    // Seed 000102030405060708090a0b0c0d0e0f, from the SLIP-0010 specification. Cross-checked against
    // `ed25519-hd-key`, an independent implementation.
    const vectorSeed = hexToBytes("000102030405060708090a0b0c0d0e0f");

    it("derives m/0'", () => {
        expect(bytesToHex(slip10Ed25519(vectorSeed, "m/0'"))).toBe(
            "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
        );
    });

    it("derives m/0'/1'", () => {
        expect(bytesToHex(slip10Ed25519(vectorSeed, "m/0'/1'"))).toBe(
            "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
        );
    });

    it("refuses an unhardened segment rather than inventing an answer", () => {
        expect(() => slip10Ed25519(vectorSeed, "m/44'/501'/0'/0")).toThrow(UnhardenedPathError);
    });
});

describe("parseHardenedPath", () => {
    it("adds the hardened bit to every segment", () => {
        // The server's role paths are fully hardened for this reason: an unhardened segment has no
        // defined answer under SLIP-0010, so it must fail here rather than at an address nobody
        // funded.
        expect(parseHardenedPath("m/44'/501'/1'/0'")).toEqual([
            0x80000000 + 44,
            0x80000000 + 501,
            0x80000000 + 1,
            0x80000000 + 0,
        ]);
    });

    it("accepts the `h` spelling", () => {
        expect(parseHardenedPath("m/0h")).toEqual([0x80000000]);
    });

    it("refuses a path that does not start at m", () => {
        expect(() => parseHardenedPath("44'/501'")).toThrow(/starts at "m"/);
    });
});
