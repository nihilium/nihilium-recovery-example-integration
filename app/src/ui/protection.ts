/**
 * Whether a chain's account is actually protected — which is not the same question as whether a
 * vault exists.
 *
 * Sealing is the off-chain half. A recovery key that no chain has registered protects nothing, and
 * the vault record has carried `settlement: null` since it was written; this is that field, read as
 * a state rather than buried in a paragraph. Until the on-chain milestone lands, every sealed chain
 * sits at `sealed`, and that is the honest reading.
 *
 * Per chain, never per vault: a vault covers the chains `addChain()` has been called for, so one
 * answer for the whole page would claim for Solana what was only ever done for Sepolia.
 */
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";

export type Protection = "unprotected" | "sealed" | "protected" | "spent";

export function protectionOf(vault: VaultRecord | null, chainId: string): Protection {
    if (vault === null) return "unprotected";
    if (vault.spent !== null) return "spent";
    const row = vault.chains.find((chain) => chain.chainId === chainId);
    if (row === undefined) return "unprotected";
    return row.settlement === null ? "sealed" : "protected";
}

export const PROTECTION_LABELS: Record<Protection, string> = {
    unprotected: "Not set up",
    sealed: "Sealed · not on-chain yet",
    protected: "Protected",
    spent: "Spent — set up again",
};
