/**
 * What is happening to this account's recovery — off-chain and on-chain, kept apart.
 *
 * These were one state and it was wrong. `spent` is the SDK's word for *the vault*: `recover()`
 * decrypted every record, so the vault is finished and can never be used again. The UI reused it to
 * mean *the recovery is done*, which is a different claim and a false one — opening the vault
 * happens on Nihilium, and at that moment nothing has reached the module. The account is still
 * controlled by exactly whoever controlled it before.
 *
 * So there are two facts:
 *
 * - **the vault**, `open` or `spent`, which this app knows because it ran the ceremony;
 * - **the attempt**, which only the chain can answer, read from `stateOf` / `attemptOf`.
 *
 * `vault-open` is the state that was being mislabelled and the one worth getting right: a key
 * exists, and the account has not changed hands. A user who reads that as "done" stops.
 *
 * **On the watchtower, precisely.** Polling `stateOf` answers "has a recovery been *submitted*" for
 * anyone who asks the chain — no watchtower needed. A watchtower answers something earlier and
 * different: `buildWatchRegistration` watches the *unsealing*, which publishes before any proof and
 * before anything on-chain, so it fires while a hostile recovery is still in the ceremony. Those are
 * separate questions and they get separate indicators.
 */
import type { VetoState } from "@nihilium/recovery-core";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import {
    hasMatured,
    nowSeconds,
    type AttemptClock,
} from "../integration/recovery/settlement/timelock.js";

export type RecoveryStage =
    /** Nothing has happened. */
    | "none"
    /** This browser is running the ceremony right now. */
    | "opening"
    /** The vault was opened and a key exists. **Nothing is on-chain.** */
    | "vault-open"
    | "initiated"
    | "paused"
    | "executable"
    /** The only state that means control actually moved. */
    | "executed"
    | "aborted";

export interface StageInputs {
    vault: VaultRecord | null;
    /** From the module. `null` means no attempt exists; `undefined` means the chain was not read. */
    attempt: VetoState | null | undefined;
    /** True while this browser's own ceremony is running. */
    opening: boolean;
    /**
     * The chain's clock, when read. Optional so a caller with no clock still gets the state word —
     * but a caller that has one must pass it, or a matured Solana attempt reads as "initiated".
     */
    clock?: AttemptClock | null;
    /** Unix seconds; defaults to now. A parameter so tests do not depend on the wall clock. */
    now?: number;
}

export function stageOf({ vault, attempt, opening, clock, now }: StageInputs): RecoveryStage | null {
    if (vault === null) return null;
    if (opening) return "opening";

    // The chain wins wherever it has something to say: it is the only party that can report an
    // attempt this browser did not start.
    // Before the switch: a matured attempt is `executable` whichever word the chain uses for it.
    // Solana keeps answering `INITIATED` after its timelock runs out, and reading only the state word
    // put "initiated" on this badge while the timelock box beside it said ready.
    if (clock !== undefined && hasMatured(attempt ?? null, clock, now ?? nowSeconds())) {
        return "executable";
    }

    switch (attempt) {
        case "INITIATED":
            return "initiated";
        case "PAUSED":
            return "paused";
        case "EXECUTABLE":
            return "executable";
        case "EXECUTED":
            return "executed";
        case "ABORTED":
            return "aborted";
        default:
            break;
    }

    // No attempt on-chain. If the vault is spent, a key was recovered and never submitted — which
    // is a state, not a completion.
    return vault.spent !== null ? "vault-open" : "none";
}

export const STAGE_LABELS: Record<RecoveryStage, string> = {
    none: "No recovery under way",
    opening: "Opening the vault",
    // Deliberately not "completed", "recovered" or "spent". It names what is missing.
    "vault-open": "Key recovered · not on-chain",
    initiated: "Submitted · timelock running",
    paused: "Paused · clock stopped",
    executable: "Timelock matured · ready",
    // Red, and from the viewer's side: this card belongs to the seed that lost the account. It does
    // not say the old key is locked out — on EVM recovery adds a validator and removes nothing.
    executed: "Recovered by another seed",
    aborted: "Aborted",
};


/** Which stages are a completed, terminal outcome — for styling, and for nothing else. */
export function isTerminalStage(stage: RecoveryStage): boolean {
    return stage === "executed" || stage === "aborted";
}
