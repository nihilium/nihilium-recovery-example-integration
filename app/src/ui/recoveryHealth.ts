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
}

export function stageOf({ vault, attempt, opening }: StageInputs): RecoveryStage | null {
    if (vault === null) return null;
    if (opening) return "opening";

    // The chain wins wherever it has something to say: it is the only party that can report an
    // attempt this browser did not start.
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
    executed: "Control moved",
    aborted: "Aborted",
};

export const STAGE_DETAIL: Record<RecoveryStage, string> = {
    none: "No recovery has been started from this browser, and the chain reports no attempt.",
    opening: "The guardians are being asked now.",
    "vault-open":
        "The vault was opened and a recovery key exists, but nothing has been submitted to the " +
        "module. This account is still controlled by whoever controlled it before — recovering the " +
        "key and taking the account back are two different steps, and only the first has happened.",
    initiated:
        "An intent is on-chain and the timelock is counting. It can still be paused or aborted.",
    paused: "The pause authority stopped the clock. It lifts at the ceiling with no transaction.",
    executable: "The timelock has matured. Executing now moves control to the named target.",
    executed: "The validator changed and the epoch bumped. This is the only state that means done.",
    aborted: "The abort key killed this attempt. It is terminal; a new recovery must start over.",
};

/** Which stages are a completed, terminal outcome — for styling, and for nothing else. */
export function isTerminalStage(stage: RecoveryStage): boolean {
    return stage === "executed" || stage === "aborted";
}
