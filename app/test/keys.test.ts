/**
 * Derivation pins.
 *
 * Two kinds of assertion here, and the difference matters:
 *
 * - **Externally verifiable.** The EVM address is what every tool that has ever loaded the Anvil
 *   mnemonic shows. If it breaks, we are wrong. The SLIP-0010 vectors moved to
 *   `packages/keys/test/` with the scheme itself — they judge the derivation, not this wallet.
 * - **Regression pins.** The Solana and Zcash addresses are this repo's own output, recorded so a
 *   change in derivation is loud. They say "this has not changed", not "this is right" — their
 *   correctness rests on the paths, the encodings, and the vectors above.
 *
 * Why pin at all: every one of these strings becomes a `ChainContext.accountId`, which is an HKDF
 * input. A silent change here re-derives every recovery key in the demo.
 */
import { describe, expect, it } from "vitest";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { toSolanaAddress } from "@nihilium/recovery-key-solana";
import { deriveEd25519, deriveSecp256k1 } from "@nihilium-demo/keys";
import { seedFromMnemonic, isValidMnemonic } from "../src/integration/keys/mnemonic.js";
import { EVM_PATH, SOLANA_PATH, ZCASH_PATHS } from "../src/integration/keys/paths.js";
import {
    decodeZcashTransparentAddress,
    toZcashTransparentAddress,
} from "../src/integration/chains/zcash/address.js";
/**
 * A fixed phrase, declared here rather than imported.
 *
 * These vectors pin derivation, so the phrase has to be constant — and the app no longer ships one:
 * it mints its own on first run. This is the published BIP-39 test vector, used as an input to the
 * arithmetic and never as a wallet.
 */
const DEMO_MNEMONIC = "test test test test test test test test test test test junk";

const seed = seedFromMnemonic(DEMO_MNEMONIC);

describe("the demo mnemonic", () => {
    it("is a valid BIP-39 phrase", () => {
        expect(isValidMnemonic(DEMO_MNEMONIC)).toBe(true);
    });

    it("rejects a phrase with a broken checksum", () => {
        expect(isValidMnemonic("test test test test test test test test test test test test")).toBe(
            false,
        );
    });
});

describe("addresses", () => {
    it("derives the EVM account every tool shows for this phrase", () => {
        // Externally verifiable: Anvil account 0.
        expect(toEvmAddress(deriveSecp256k1(seed, EVM_PATH).publicKey)).toBe(
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        );
    });

    it("derives one Solana account", () => {
        expect(toSolanaAddress(deriveEd25519(seed, SOLANA_PATH).publicKey)).toBe(
            "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96",
        );
    });

    it("derives three Zcash testnet t-addresses", () => {
        const addresses = ZCASH_PATHS.map((entry) =>
            toZcashTransparentAddress(deriveSecp256k1(seed, entry.path).publicKey, "test"),
        );
        expect(addresses).toEqual([
            "tmLoFfsS1hx5qnazZX6QTn9UoosxTPCYRwz",
            "tmF54Zh45twuzJHAZsGVwt1dH3DPkjYpJa9",
            "tmMd4q4R4S2nVrPgxuwD8EBHVcFBwTzofMT",
        ]);
        // The prefix is the whole difference from a Bitcoin address, so it is checked rather than
        // assumed: every one of these must decode as testnet.
        for (const address of addresses) {
            expect(decodeZcashTransparentAddress(address).network).toBe("test");
            expect(decodeZcashTransparentAddress(address).hash).toHaveLength(20);
        }
    });

    it("refuses to build a t-address from the wrong curve", () => {
        const ed = deriveEd25519(seed, SOLANA_PATH);
        expect(() => toZcashTransparentAddress(ed.publicKey, "test")).toThrow(/secp256k1/);
    });
});
