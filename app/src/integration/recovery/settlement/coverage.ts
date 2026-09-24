/**
 * Which chains still need this vault's recovery key, and which do not — with a reason either way.
 *
 * A wallet holds one gate over several chains, so "is this protected?" has as many answers as there
 * are chains, and the interesting one is always the chain nobody is looking at. This turns a row per
 * chain into two lists: what one action would do, and what it would leave alone.
 *
 * **Every skip carries its reason, and the reasons are not interchangeable.** A chain with no funds,
 * a chain this build cannot settle, and a chain whose state could not be read are three different
 * situations that all look like "nothing to do" from the outside — and only the third is a problem.
 * Collapsing them into an absence is how a chain stays unprotected quietly.
 *
 * **Two rules worth stating, because both cut against the obvious reading of "chains with funds":**
 *
 * - *An unreadable balance is offered, not skipped.* It is not a zero balance; skipping it would be
 *   this code claiming there is nothing there, which is exactly what it failed to find out.
 * - *An unreadable chain state is skipped, and loudly.* The opposite call, and for a concrete
 *   reason rather than symmetry: choosing between installing and replacing needs to know what is
 *   installed, and guessing wrong reverts. An unknown balance costs nothing to be wrong about; an
 *   unknown module state costs the transaction.
 *
 * **To replace:** nothing, if your chains are these. The inputs are deliberately facts — `installed`,
 * `matchesVault`, a balance — rather than a rendered status, so this never has to agree with a UI
 * label about what "stale" means.
 * **Assumes:** `onchain` came from a live read this session. A remembered one would let a chain
 * somebody else changed read as protected.
 */

/** What protecting this chain would actually do. `update` replaces a key the chain already holds. */
export type ProtectAction = "protect" | "update";

export interface CoverageRow {
    chainId: string;
    chainLabel: string;
    /** Whether this build can register a recovery key on this chain at all. */
    settles: boolean;
    /** Whether a vault covering this wallet exists, and whether it has been spent. */
    hasVault: boolean;
    vaultSpent: boolean;
    /** `null` when the balance could not be read. Never zero standing in for unknown. */
    balanceRaw: bigint | null;
    balanceError: string | null;
    /**
     * The units that balance came in — 18 on Ethereum, 9 on Solana, 8 on Zcash.
     *
     * Carried with the amount rather than looked up beside it, because they arrive together on the
     * `Balance` and a formatter handed the wrong pair shows a number off by a billion.
     */
    balanceDecimals: number | null;
    balanceSymbol: string | null;
    /** What the chain holds. `null` when it was not read or could not be. */
    onchain: { installed: boolean; matchesVault: boolean } | null;
    onchainError: string | null;
}

export interface ProtectTarget {
    chainId: string;
    chainLabel: string;
    action: ProtectAction;
    balanceRaw: bigint | null;
    balanceDecimals: number | null;
    balanceSymbol: string | null;
    /** True where the balance could not be read, so the row can say so rather than imply funds. */
    balanceUnknown: boolean;
}

export interface SkippedChain {
    chainId: string;
    chainLabel: string;
    reason: string;
}

export function chainsToProtect(rows: readonly CoverageRow[]): {
    targets: ProtectTarget[];
    skipped: SkippedChain[];
} {
    const targets: ProtectTarget[] = [];
    const skipped: SkippedChain[] = [];
    const skip = (row: CoverageRow, reason: string) =>
        skipped.push({ chainId: row.chainId, chainLabel: row.chainLabel, reason });

    for (const row of rows) {
        if (!row.settles) {
            skip(row, "no settlement is wired for this chain in this build");
            continue;
        }
        if (!row.hasVault) {
            skip(row, "no gate to register — set up recovery first");
            continue;
        }
        if (row.vaultSpent) {
            // A spent vault's key is exposed. Registering it again would install a gate whose key
            // the recovery already handed out.
            skip(row, "vault spent — set up a new gate");
            continue;
        }
        if (row.onchain === null) {
            // Two different situations, and saying "could not be read" for both is how a chain that
            // was never asked got filed as a chain that failed — and skipped, with funds on it.
            skip(
                row,
                row.onchainError === null ? "not read" : `could not be read: ${row.onchainError}`,
            );
            continue;
        }
        if (row.onchain.installed && row.onchain.matchesVault) {
            skip(row, "already protected by this gate");
            continue;
        }
        // Readable and empty. The only skip that is a judgement about value rather than about state.
        if (row.balanceRaw !== null && row.balanceRaw === 0n) {
            skip(
                row,
                row.onchain.installed ? "no funds · still on the old guardians" : "no funds",
            );
            continue;
        }

        targets.push({
            chainId: row.chainId,
            chainLabel: row.chainLabel,
            // Installed but not this vault's key: the chain honours the gate you replaced, so the
            // *old* guardians are the ones who could recover it until this lands.
            action: row.onchain.installed ? "update" : "protect",
            balanceRaw: row.balanceRaw,
            balanceDecimals: row.balanceDecimals,
            balanceSymbol: row.balanceSymbol,
            balanceUnknown: row.balanceRaw === null,
        });
    }

    return { targets, skipped };
}

/** Chains the gate covers but the chain does not honour. Drives the notice, not the button. */
export function staleChains(rows: readonly CoverageRow[]): readonly CoverageRow[] {
    return rows.filter(
        (row) => row.onchain !== null && row.onchain.installed && !row.onchain.matchesVault,
    );
}
