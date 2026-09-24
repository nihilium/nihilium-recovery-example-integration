/**
 * A recovery that has been submitted and is waiting out its timelock.
 *
 * **Why this exists.** Opening a vault yields keys; moving the account takes three on-chain steps
 * and a wait that the chain enforces and nothing can shorten. Those two facts fight: the keys live
 * in memory, and a timelock can outlast the browser session by days. The naive answers are both bad
 * — keep the dialog open and a closed tab costs the recovery, or write the recovered keys to disk
 * and the demo is doing the one thing §12's placement rule exists to prevent.
 *
 * So the keys are used once, immediately, and thrown away. At recovery time every chain's intent is
 * built, signed and submitted; what persists is the **signed intent**, which authorises exactly one
 * handover to one named owner and is worth nothing to anyone else. Coming back later — after a
 * reload, on the next day — needs no key at all: `executeRecovery` takes the intent and no
 * signature, because by then the timelock is the authority.
 *
 * That matters more than it sounds: a vault is spent the moment it is opened, so a recovery that
 * loses its keys mid-timelock cannot be redone without buying another ceremony.
 *
 * **To replace:** the storage calls. What must not change is what goes in: intents, never key
 * material. **Assumes:** `intent` is kept byte-identical to the one submitted — the module re-hashes
 * it at execute time and compares, and a re-encoded field is an attempt that can never mature.
 */
import type { VetoState } from "@nihilium/recovery-core";
import { STORES, detach, withStore, type IdbOptions } from "../storage/indexeddb.js";
import { hasMatured, projectTimelock, type AttemptClock } from "./settlement/timelock.js";
import type { VaultRecord } from "./vaultRecords.js";

export type HandoverStage =
    /** The intent is on-chain and the timelock is counting. */
    | "submitted"
    /** The timelock matured and control has moved. Funds have not. */
    | "executed"
    /** Everything the account held has been sent on. Terminal. */
    | "swept"
    /** This chain could not be carried through. The others are unaffected. */
    | "failed";

export interface HandoverRecord {
    /** `${vaultId}:${chainId}` — one per chain per vault. */
    id: string;
    vaultId: string;
    chainId: string;
    /** The account being recovered, in that chain's own notation. */
    accountId: string;
    /**
     * The key that created the account, where the account is not that key.
     *
     * Stored here rather than looked up, so this row is the whole input to `execute` and `sweep`.
     * Those run in a later session — possibly after the vault record has been deleted — and a row
     * that had to be joined back to a ledger the user can clear would be a recovery that stops
     * working for a reason nobody would connect to the delete button.
     */
    signerAddress: string | null;
    /** Where control was handed. A key the destination seed derives, so this app can sign with it. */
    newOwner: string;
    /**
     * Where the funds go once control lands — the destination seed's own protected account, not the
     * key that now controls this one. Two different addresses, and conflating them would sweep into
     * an ordinary keypair rather than into something a recovery could protect later.
     */
    sweepTo: string;
    /** Which seed receives all this, by fingerprint. Shown, never used to derive anything. */
    ownerWalletId: string;
    /**
     * The intent, exactly as submitted. Re-hashed by the module at execute time, so any re-encoding
     * between here and there is an attempt that can never mature.
     */
    intent: unknown;
    stage: HandoverStage;
    submittedAt: number;
    initiateTx: string | null;
    executeTx: string | null;
    sweepTx: string | null;
    /** Why this chain stopped, when it did. */
    failure: string | null;
}

export function handoverId(vaultId: string, chainId: string): string {
    return `${vaultId}:${chainId}`;
}

export class HandoverStore {
    constructor(private readonly options: IdbOptions = {}) {}

    async put(record: HandoverRecord): Promise<void> {
        await withStore(this.options, STORES.handovers, "readwrite", (store, run) =>
            run(store.put(record)),
        );
    }

    async forVault(vaultId: string): Promise<HandoverRecord[]> {
        const rows = await withStore(this.options, STORES.handovers, "readonly", (store, run) =>
            run<HandoverRecord[]>(store.index("byVault").getAll(vaultId)),
        );
        return rows.map((row) => detach(row));
    }

    async list(): Promise<HandoverRecord[]> {
        const rows = await withStore(this.options, STORES.handovers, "readonly", (store, run) =>
            run<HandoverRecord[]>(store.getAll()),
        );
        return rows.map((row) => detach(row));
    }

    async delete(id: string): Promise<void> {
        await withStore(this.options, STORES.handovers, "readwrite", (store, run) =>
            run(store.delete(id)),
        );
    }
}

/**
 * What the one button should say and whether it can do anything yet.
 *
 * Collapsed across chains on purpose: the point of the button is that a user moves a *vault*, not a
 * chain at a time. A vault half-executed is still waiting, because the funds cannot all move until
 * the slowest chain matures.
 */
export function handoverProgress(records: readonly HandoverRecord[]): {
    stage: HandoverStage | "none";
    /** Chains still counting down. Zero means every chain is ready or done. */
    waiting: number;
    swept: number;
    failed: number;
    total: number;
} {
    if (records.length === 0) {
        return { stage: "none", waiting: 0, swept: 0, failed: 0, total: 0 };
    }
    const waiting = records.filter((row) => row.stage === "submitted").length;
    const swept = records.filter((row) => row.stage === "swept").length;
    const failed = records.filter((row) => row.stage === "failed").length;
    const live = records.filter((row) => row.stage !== "failed");

    const stage: HandoverStage | "none" =
        live.length === 0
            ? "failed"
            : waiting > 0
              ? "submitted"
              : swept === live.length
                ? "swept"
                : "executed";

    return { stage, waiting, swept, failed, total: records.length };
}

/**
 * What the chain says about one attempt — the shape both chains' `readAttemptClock` already return.
 */
export interface ChainAttempt {
    projected: VetoState | null;
    clock: AttemptClock | null;
    unreadable: string | null;
}

/**
 * A handover row as it actually stands: the local row, checked against the chain.
 *
 * `counting` and `paused` are waits; `ready` and `executed` are things the Move button can act on;
 * the rest are ends. `missing` is the chain contradicting the row — the row says an intent was
 * submitted and the chain holds no attempt — and `unread` is not having an answer yet, which is
 * never rendered as ready.
 */
export type LiveStage =
    | "counting"
    | "paused"
    | "ready"
    | "executed"
    | "swept"
    | "aborted"
    | "missing"
    | "unread"
    | "failed";

export interface LiveHandover {
    stage: LiveStage;
    /** Until the timelock matures, where the chain says. */
    remainingSeconds: number | null;
    /** Why the chain could not be read, where it could not. */
    reason: string | null;
}

/**
 * The row, reconciled with the chain.
 *
 * **Why this exists.** A row's `stage` is this app's own bookkeeping: it is written `submitted` at
 * initiate and moves only when this app executes. It knows nothing about the clock. The handover
 * view used to render it directly, so a recovery whose timelock had matured still read "timelock
 * running" — and `waiting`, computed from the same field, kept the Move button disabled for good.
 * Nothing could ever be moved.
 *
 * The rule is that **the row is authoritative about what this app did, and the chain about
 * everything else.** `failed`, `executed` and `swept` are records of our own transactions and stand
 * as written. `submitted` is a claim about the chain, so the chain is asked.
 */
export function reconcileHandover(
    record: HandoverRecord,
    attempt: ChainAttempt | undefined,
    nowSeconds: number,
): LiveHandover {
    const done = (stage: LiveStage): LiveHandover => ({ stage, remainingSeconds: null, reason: null });

    if (record.stage === "failed") return done("failed");
    if (record.stage === "swept") return done("swept");
    if (record.stage === "executed") return done("executed");

    if (attempt === undefined) return done("unread");
    if (attempt.unreadable !== null) {
        return { stage: "unread", remainingSeconds: null, reason: attempt.unreadable };
    }

    // Executed by anyone: after the timelock the intent is executable by whoever holds it, so the
    // chain can be ahead of this app's row.
    if (attempt.projected === "EXECUTED") return done("executed");
    if (attempt.projected === "ABORTED") return done("aborted");
    if (attempt.projected === null) return done("missing");

    if (hasMatured(attempt.projected, attempt.clock, nowSeconds)) return done("ready");

    const remaining =
        attempt.clock === null ? null : projectTimelock(attempt.clock, nowSeconds).remainingSeconds;
    return {
        stage: attempt.projected === "PAUSED" ? "paused" : "counting",
        remainingSeconds: remaining,
        reason: null,
    };
}

/** The chains one press of Move would actually act on: matured, or executed and not yet swept. */
export function movableChains(
    records: readonly HandoverRecord[],
    live: readonly LiveHandover[],
): string[] {
    return records
        .filter((_, index) => live[index]?.stage === "ready" || live[index]?.stage === "executed")
        .map((record) => record.chainId);
}

/** The `reason` written when a vault's spent mark is rebuilt from its handover rows. */
export const SPENT_FROM_HANDOVER = "Recovered in this browser.";

/**
 * Vaults that were opened but are not marked spent — rebuilt as spent, ready to be saved.
 *
 * A handover row exists only for a vault whose ceremony succeeded: `submitAll` runs after the keys
 * come back and never before. So a row is proof the vault was opened, and a vault that was opened
 * is spent. This repairs records written before the spent mark was saved at recovery time — those
 * read as "recovery ready", green, for a vault that had already been recovered from.
 *
 * Only ever marks, never clears: a vault already marked keeps its own `at` and `reason`.
 */
export function spentFromHandovers(
    vaults: readonly VaultRecord[],
    handovers: readonly HandoverRecord[],
): VaultRecord[] {
    const openedAt = new Map<string, number>();
    for (const row of handovers) {
        openedAt.set(row.vaultId, Math.min(openedAt.get(row.vaultId) ?? Infinity, row.submittedAt));
    }
    return vaults
        .filter((vault) => vault.spent === null && openedAt.has(vault.vaultId))
        .map((vault) => ({
            ...vault,
            spent: { at: openedAt.get(vault.vaultId)!, reason: SPENT_FROM_HANDOVER },
        }));
}
