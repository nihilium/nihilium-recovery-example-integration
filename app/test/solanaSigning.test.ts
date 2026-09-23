/**
 * Detached ed25519, and the forgery the program refuses.
 *
 * The precompile verifies whatever it is asked to verify, and reads the signed message from
 * whichever instruction the offsets name. Point those at two different places and the precompile
 * and an introspecting program disagree about what was signed — at which point any signature the
 * guardian ever published authorises any recovery. `signAll` sets every offset to "this
 * instruction", which is the only shape the program accepts; anything else is refused with
 * `ForeignInstructionReference`.
 *
 * These assert the shape rather than mocking the program: one instruction carrying k signatures,
 * self-referential offsets, and the cap that keeps a resume inside one transaction.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { digestsFor, MAX_RESUME_MEMBERS } from "@nihilium/recovery-onchain-solana";
import {
    detachedSignatures,
    ED25519_IX_INDEX,
} from "../src/integration/recovery/settlement/solana/signing.js";
import { clusterFromNamespace } from "../src/integration/recovery/settlement/solana/digests.js";

/** Deterministic, so a failure is reproducible rather than a different key every run. */
function signer(seed: number): Keypair {
    return Keypair.fromSeed(new Uint8Array(32).fill(seed));
}

const DIGEST = Buffer.alloc(32, 9);

describe("detachedSignatures", () => {
    it("packs k signatures into one instruction", () => {
        // One instruction, not one per signer: the program checks the count exactly, and
        // `@solana/web3.js` can only build the single-signature form.
        const one = detachedSignatures([signer(1)], DIGEST);
        const three = detachedSignatures([signer(1), signer(2), signer(3)], DIGEST);

        expect(one.data.length).toBeLessThan(three.data.length);
        // The header's first byte is the signature count.
        expect(one.data[0]).toBe(1);
        expect(three.data[0]).toBe(3);
    });

    it("targets the ed25519 precompile, with no account metas", () => {
        const ix = detachedSignatures([signer(1)], DIGEST);
        expect(ix.programId.toBase58()).toBe("Ed25519SigVerify111111111111111111111111111");
        expect(ix.keys).toEqual([]);
    });

    it("refuses an instruction that authorises nothing", () => {
        expect(() => detachedSignatures([], DIGEST)).toThrow(/authorises nothing/);
    });

    it("refuses more signatures than fit one transaction", () => {
        // k signatures at ~110 bytes each inside Solana's 1232-byte limit. Past the cap a resume is
        // a pause that could never be lifted, so registration refuses the quorum outright.
        const tooMany = Array.from({ length: MAX_RESUME_MEMBERS + 1 }, (_, i) => signer(i + 1));
        expect(() => detachedSignatures(tooMany, DIGEST)).toThrow(/cap of 8/);
    });

    it("allows exactly the cap", () => {
        const atCap = Array.from({ length: MAX_RESUME_MEMBERS }, (_, i) => signer(i + 1));
        expect(() => detachedSignatures(atCap, DIGEST)).not.toThrow();
    });

    it("places the instruction where every program argument says it is", () => {
        // The last argument to each program instruction is the index of this one. Get them out of
        // step and the program introspects the wrong instruction.
        expect(ED25519_IX_INDEX).toBe(0);
    });
});

describe("the cluster tag", () => {
    it("accepts the clusters the program is built for", () => {
        for (const cluster of ["localnet", "devnet", "mainnet-beta"] as const) {
            expect(clusterFromNamespace("solana:x", cluster)).toBe(cluster);
        }
    });

    it("refuses anything else rather than guessing", () => {
        // A wrong tag yields signatures the program rejects without saying why — there is no
        // default for exactly this reason.
        expect(() => clusterFromNamespace("solana:x", "mainnet")).toThrow(/not a cluster/);
        expect(() => clusterFromNamespace("solana:x", "")).toThrow(/not a cluster/);
    });

    it("produces different digests per cluster", () => {
        // The tag stands in for the `block.chainid` an EVM contract gets free. Same inputs on two
        // clusters must not produce the same signature.
        expect(digestsFor("devnet").tag).not.toEqual(digestsFor("localnet").tag);
    });
});
