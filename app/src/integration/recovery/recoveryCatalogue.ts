/**
 * Everything this browser could still open, and which of it actually needs opening.
 *
 * A wallet that only offers recovery for the account you are *currently signed into* has the logic
 * backwards. Recovery exists for the case where the seed is gone — so the vault that most needs a
 * way in is precisely the one whose wallet cannot be derived any more, and that is the one a
 * card keyed on "the active account" can never show. This app had exactly that hole: the only way
 * into a recovery was a link on the wallet card, which rendered only when the *active* seed already
 * had a vault. Make a new seed, and there was no way back to the old one's gate at all.
 *
 * So this sorts by the thing that matters — whether the seed is still here — rather than by date or
 * by chain, and `lost` comes first.
 *
 * **To replace:** `knownWalletIds`, with whatever your wallet can enumerate. A real wallet holds one
 * account and the answer is a boolean; the list exists here because this demo can hold several.
 * **Assumes:** a vault is openable from this browser when its seal is here. The records matter too,
 * but they are inert and duplicable by design (§12) — a missing seal is the unrecoverable half, so
 * it is the one reported.
 */
import type { SealRef } from "@nihilium/recovery-core";
import type { VaultRecord } from "./vaultRecords.js";

export type SeedStatus = "present" | "lost";

export interface CachedRecovery {
    vault: VaultRecord;
    /**
     * Whether the wallet this vault protects can still be derived here.
     *
     * `lost` is not an error state. It is the state recovery is *for*, and the reason these sort
     * first.
     */
    seedStatus: SeedStatus;
    /**
     * Whether this browser holds the seal. Without it a recovery cannot start at all, and the only
     * way back is the file the user was handed at seal time.
     */
    hasSeal: boolean;
    chainIds: readonly string[];
}

export interface RecoveryCatalogue {
    /** Seed gone. The vaults that actually need this screen. */
    lost: readonly CachedRecovery[];
    /** Seed still here. Recoverable, but a rehearsal rather than a rescue. */
    present: readonly CachedRecovery[];
}

export function groupRecoveries(params: {
    vaults: readonly VaultRecord[];
    seals: readonly SealRef[];
    /** Every wallet this browser can still derive. The demo passes one fingerprint per seed. */
    knownWalletIds: readonly string[];
}): RecoveryCatalogue {
    const known = new Set(params.knownWalletIds);
    const sealed = new Set(params.seals.map((ref) => ref.vaultId));

    const rows = params.vaults.map((vault): CachedRecovery => ({
        vault,
        seedStatus: known.has(vault.walletId) ? "present" : "lost",
        hasSeal: sealed.has(vault.vaultId),
        chainIds: vault.chains.map((chain) => chain.chainId),
    }));

    // Newest first within each group: a vault sealed after a re-key supersedes the one before it,
    // and showing the superseded one at the top invites opening the wrong gate.
    const byNewest = (a: CachedRecovery, b: CachedRecovery) => b.vault.createdAt - a.vault.createdAt;

    return {
        lost: rows.filter((row) => row.seedStatus === "lost").sort(byNewest),
        present: rows.filter((row) => row.seedStatus === "present").sort(byNewest),
    };
}

/** Whether there is anything at all to show. Used to keep the card off an empty wallet. */
export function isEmpty(catalogue: RecoveryCatalogue): boolean {
    return catalogue.lost.length === 0 && catalogue.present.length === 0;
}

/**
 * Whether a given wallet has a recovery, and whether it is one you could actually run.
 *
 * Four answers rather than a boolean, because "has a gate" and "can be opened from here" are
 * different questions and the gap between them is the one worth showing. A vault whose seal this
 * browser no longer holds still exists and still protects the account — but not from this device,
 * and a green tick against it would be the demo saying you are covered when you are not.
 */
export type SeedRecoveryState =
    /** No gate was ever set up for this wallet. */
    | "none"
    /** A gate exists, its seal is here, and it has not been spent. */
    | "ready"
    /** A gate exists but this browser holds no seal for it — recoverable only from the file. */
    | "no-seal"
    /** Every gate this wallet had has been opened. A spent vault is never silently reused. */
    | "spent";

export interface SeedRecovery {
    state: SeedRecoveryState;
    /** The gate's own words, from the newest usable vault. `null` when there is nothing to describe. */
    summary: string | null;
    /** How many vaults this wallet has, usable or not. */
    vaults: number;
}

export function seedRecovery(params: {
    vaults: readonly VaultRecord[];
    seals: readonly SealRef[];
    walletId: string;
}): SeedRecovery {
    const sealed = new Set(params.seals.map((ref) => ref.vaultId));
    const mine = params.vaults
        .filter((vault) => vault.walletId === params.walletId)
        // Newest first: a re-seal supersedes the gate before it, and describing the older one
        // would name guardians that no longer open anything.
        .sort((a, b) => b.createdAt - a.createdAt);

    if (mine.length === 0) return { state: "none", summary: null, vaults: 0 };

    const live = mine.filter((vault) => vault.spent === null);
    const ready = live.find((vault) => sealed.has(vault.vaultId));
    if (ready !== undefined) {
        return { state: "ready", summary: ready.gate.summary ?? null, vaults: mine.length };
    }
    // A gate with no seal here outranks "spent" as the thing to report: it is still openable, just
    // not from this device, and telling someone their vault is finished when it is not is worse.
    if (live.length > 0) {
        return { state: "no-seal", summary: live[0]!.gate.summary ?? null, vaults: mine.length };
    }
    return { state: "spent", summary: mine[0]!.gate.summary ?? null, vaults: mine.length };
}

export const SEED_RECOVERY_LABEL: Record<SeedRecoveryState, string> = {
    none: "no recovery",
    ready: "recovery ready",
    "no-seal": "recovery — no seal here",
    spent: "recovered from · set up again",
};
