/**
 * Where a recovery hands control — and the one seed it may never hand it to.
 *
 * Two rules, both the SDK's rather than this app's:
 *
 * - A recovery decrypts every record in the vault, so the protected wallet's root secret is exposed
 *   to whoever ran it. Handing the account back to that seed hands it to a key the ceremony just
 *   published, and a new gate on the same seed changes nothing — the key derives from the root.
 * - The destination is chain-shaped. Until this existed, `useRecoveryChain` typed the target as an
 *   EVM `Address` and handed it to Solana as `newOwner` unchanged, naming a destination the program
 *   could never accept.
 */
import { describe, expect, it } from "vitest";
import { destinationFor, destinationsFor, eligibleOwners } from "../src/demo/destinations.js";
import { seedFingerprint } from "../src/demo/seeds.js";

const A = "case feed neck junior pave stage buzz gather ridge buddy kingdom alien";
const B = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("a destination per chain", () => {
    it("derives an EVM address and a Solana address from one seed", () => {
        const [evm, solana] = destinationsFor(A);
        expect(evm!.chainId).toBe("evm-sepolia");
        expect(evm!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(solana!.chainId).toBe("solana-devnet");
        // Base58, and emphatically not an EVM address — the bug this file exists for.
        expect(solana!.address).not.toMatch(/^0x/);
        expect(solana!.address).not.toBe(evm!.address);
    });

    it("is deterministic, so the address shown is the address recovered to", () => {
        expect(destinationsFor(A).map((d) => d.address)).toEqual(
            destinationsFor(A).map((d) => d.address),
        );
    });

    it("moves with the seed", () => {
        expect(destinationFor(A, "evm-sepolia")!.address).not.toBe(
            destinationFor(B, "evm-sepolia")!.address,
        );
    });

    it("does not land on the wallet's own account branch", () => {
        // `1'`, not `0'`: control must not land on the key the recovered account was built from.
        expect(destinationFor(A, "evm-sepolia")!.derivationPath).toContain("/1'/");
    });

    it("returns null for a chain with no destination rather than guessing one", () => {
        expect(destinationFor(A, "zcash-testnet")).toBeNull();
    });

    it("can sign as the new owner, which is why control is a seed and not a pasted string", () => {
        const key = destinationFor(A, "evm-sepolia")!.exportPrivateKeyHex_DEMO_ONLY();
        expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    });
});

describe("who may receive control", () => {
    const seeds = [{ mnemonic: A }, { mnemonic: B }];

    it("excludes the seed the vault protects", () => {
        const eligible = eligibleOwners(seeds, seedFingerprint(A), seedFingerprint);
        expect(eligible.map((s) => s.mnemonic)).toEqual([B]);
    });

    it("returns nothing when the only seed is the vault's own", () => {
        // A real answer, not a failure: a one-seed wallet has nowhere for control to go, and the
        // honest next step is to make a seed for it.
        expect(eligibleOwners([{ mnemonic: A }], seedFingerprint(A), seedFingerprint)).toEqual([]);
    });

    it("offers every seed when the vault belongs to none of them", () => {
        // An imported seal file: the vault's wallet is unknown here, so no seed is disqualified.
        expect(eligibleOwners(seeds, "imported — seed unknown", seedFingerprint)).toHaveLength(2);
    });
});
