/**
 * Whether the chain honours the gate this app is showing.
 *
 * `stale` is the state worth testing: replacing guardians makes a new vault with a new recovery key,
 * and the module has no setter — so until an uninstall-and-install lands, the chain still honours
 * the *previous* gate. The account is not unprotected and it is not protected by what the screen
 * says; it is protected by the guardians the user just replaced, and the new ones cannot open it.
 *
 * The other cell that matters is "not read yet". An unread chain must never render as an
 * uninstalled module, because the difference between "nothing is there" and "nobody looked" is the
 * difference between a warning and a lie.
 */
import { describe, expect, it } from "vitest";
import { PROTECTION_LABELS, protectionOf, type OnChainProtection } from "../src/ui/protection.js";
import type { VaultRecord } from "../src/integration/recovery/vaultRecords.js";

const CHAIN = "evm-sepolia";

function vault(over: Partial<VaultRecord> = {}): VaultRecord {
    return {
        vaultId: "v1",
        spent: null,
        chains: [{ chainId: CHAIN, settlement: null }],
        ...over,
    } as VaultRecord;
}

const onchain = (over: Partial<OnChainProtection> = {}): OnChainProtection => ({
    installed: true,
    matchesVault: true,
    ...over,
});

describe("protectionOf", () => {
    it("is unprotected with no vault at all", () => {
        expect(protectionOf(null, CHAIN, onchain())).toBe("unprotected");
    });

    it("is unprotected when the vault does not cover this chain", () => {
        // A vault covers the chains `addChain()` was called for. Solana not being in it is not a
        // reason to call Sepolia unprotected, and vice versa.
        expect(protectionOf(vault(), "solana-devnet", onchain())).toBe("unprotected");
    });

    it("is sealed when the chain has not been read", () => {
        // `undefined` is "nobody looked". Rendering that as "no module installed" would be this app
        // asserting something it has not checked.
        expect(protectionOf(vault(), CHAIN, undefined)).toBe("sealed");
        expect(protectionOf(vault(), CHAIN, null)).toBe("sealed");
    });

    it("is sealed when the module is genuinely not installed", () => {
        expect(protectionOf(vault(), CHAIN, onchain({ installed: false, matchesVault: false }))).toBe(
            "sealed",
        );
    });

    it("is protected when the chain holds this vault's key", () => {
        expect(protectionOf(vault(), CHAIN, onchain())).toBe("protected");
    });

    it("is stale when the chain holds a different gate's key", () => {
        // The case this file exists for: a re-seal happened and the rotation never landed.
        const state = protectionOf(vault(), CHAIN, onchain({ matchesVault: false }));
        expect(state).toBe("stale");
        // And it must not read as a lesser "protected" — the label names the problem.
        expect(PROTECTION_LABELS[state]).toBe("On the old guardians");
    });

    it("is spent regardless of what the chain says", () => {
        const opened = vault({ spent: { at: 1, reason: "every record was decrypted" } });
        for (const chainState of [onchain(), onchain({ matchesVault: false }), undefined]) {
            expect(protectionOf(opened, CHAIN, chainState)).toBe("spent");
        }
    });

    it("gives every state a label that does not claim more than it has", () => {
        expect(PROTECTION_LABELS.unprotected).toBe("Not set up");
        expect(PROTECTION_LABELS.sealed).toBe("Sealed · not on-chain yet");
        expect(PROTECTION_LABELS.protected).toBe("Protected");
        // Neither `sealed` nor `stale` may read as a plain success.
        for (const state of ["sealed", "stale", "spent", "unprotected"] as const) {
            expect(PROTECTION_LABELS[state]).not.toBe("Protected");
        }
    });
});
