/**
 * What a chain must provide for a recovery to mean anything on it.
 *
 * This extends the SDK's own `SettlementAdapter` (§4, §8, §9) rather than paralleling it, so a file
 * implementing this is a file implementing the SDK's contract — with two additions the SDK has no
 * opinion about because they are a *demo's* problem:
 *
 * - `fidelity` says whether this chain's construction is really enforcing anything. It travels with
 *   every value the binding returns, which is what stops a component rendering a simulated result
 *   without the datum that demands the badge.
 * - `advanceClock` exists only on a simulation. Its absence on a real chain is the type telling a
 *   caller which one it holds, instead of a comment asking it to remember.
 *
 * The register / initiate / veto / status surface is core's and is documented there.
 */
import type { SettlementAdapter, VetoState } from "@nihilium/recovery-core";

export type Fidelity = "onchain" | "simulated";

export interface SettlementBinding extends SettlementAdapter {
    readonly fidelity: Fidelity;
    /** One sentence, shown under the badge. "Replayed locally by @nihilium/recovery-veto", say. */
    readonly fidelityNote: string;
}

/** A settlement action's receipt. `hash` is `null` when simulated: no plausible-looking fake hex. */
export interface SettlementTx {
    hash: string | null;
    fidelity: Fidelity;
    explorerUrl: string | null;
    at: number;
}

export interface VetoSnapshot {
    status: VetoState;
    accruedSeconds: number | null;
    remainingSeconds: number | null;
    pausedSeconds: number | null;
    fidelity: Fidelity;
    observedAt: number;
}
