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

export type Protection = "unprotected" | "sealed" | "protected" | "stale" | "spent";

/**
 * What the chain says, when it has been read.
 *
 * `null` means "not asked yet" and is not the same as "nothing is installed" — an unread chain must
 * not render as an unprotected account.
 */
export interface OnChainProtection {
    installed: boolean;
    /** Whether the installed `recoveryOwner` is *this* vault's key. */
    matchesVault: boolean;
}

export function protectionOf(
    vault: VaultRecord | null,
    chainId: string,
    onchain?: OnChainProtection | null,
): Protection {
    if (vault === null) return "unprotected";
    if (vault.spent !== null) return "spent";
    const row = vault.chains.find((chain) => chain.chainId === chainId);
    if (row === undefined) return "unprotected";

    // Until the chain has been read, the vault record is all there is — and it only ever knows
    // whether *this app* registered something, which is why the honest answer is "sealed".
    if (onchain === undefined || onchain === null) return "sealed";
    if (!onchain.installed) return "sealed";
    // Installed, but holding someone else's key. A replaced gate whose rotation never landed: the
    // vault you hold cannot open the account, and the key that can is one you have discarded.
    return onchain.matchesVault ? "protected" : "stale";
}

export const PROTECTION_LABELS: Record<Protection, string> = {
    unprotected: "Not set up",
    sealed: "Sealed · not on-chain yet",
    protected: "Protected",
    stale: "Protected by a replaced gate",
    spent: "Spent — set up again",
};
