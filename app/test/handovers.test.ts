/**
 * A recovery that has to survive its own timelock.
 *
 * The keys come out of a ceremony that spent the vault; the chain then makes you wait, and the wait
 * can outlast the browser session. Keeping the keys for it would put bearer material on disk, and
 * losing them means the recovery cannot be redone without buying another ceremony. So what is stored
 * is the **signed intent** — good for exactly one handover to one named owner — and `executeRecovery`
 * needs no signature by then, because the timelock is the authority.
 */
import { describe, expect, it } from "vitest";
import {
    handoverId,
    handoverProgress,
    type HandoverRecord,
    reconcileHandover,
    spentFromHandovers,
    movableChains,
    type ChainAttempt,
} from "../src/integration/recovery/handovers.js";

function row(over: Partial<HandoverRecord> & Pick<HandoverRecord, "chainId" | "stage">): HandoverRecord {
    return {
        id: handoverId("v1", over.chainId),
        vaultId: "v1",
        accountId: "0xacc",
        signerAddress: null,
        newOwner: "0xnew",
        sweepTo: "0xsafe",
        ownerWalletId: "case…alien",
        intent: { epoch: 0 },
        submittedAt: 1,
        initiateTx: "0xtx",
        executeTx: null,
        sweepTx: null,
        failure: null,
        ...over,
    };
}

describe("the record", () => {
    it("is one per chain per vault, so a re-run replaces rather than duplicates", () => {
        expect(handoverId("v1", "evm-sepolia")).toBe("v1:evm-sepolia");
        expect(handoverId("v1", "evm-sepolia")).not.toBe(handoverId("v1", "solana-devnet"));
    });

    it("carries no key material at all", () => {
        // The invariant the whole design rests on. An intent authorises one handover to one named
        // owner; a key authorises everything, forever, and must never reach storage.
        const keys = Object.keys(row({ chainId: "evm-sepolia", stage: "submitted" }));
        expect(keys).not.toContain("material");
        expect(keys).not.toContain("privateKey");
        expect(keys).toContain("intent");
    });
});

describe("collapsing chains into one answer", () => {
    /**
     * The button moves a *vault*, not a chain at a time. So a vault is only ready when every chain
     * is — the funds cannot all move until the slowest timelock matures, and reporting "ready"
     * off the fastest one would offer an action that half-fails.
     */
    it("reports nothing when no recovery has been submitted", () => {
        expect(handoverProgress([]).stage).toBe("none");
    });

    it("is still waiting while any chain is counting", () => {
        const progress = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "executed" }),
            row({ chainId: "solana-devnet", stage: "submitted" }),
        ]);
        expect(progress.stage).toBe("submitted");
        expect(progress.waiting).toBe(1);
    });

    it("is executed once every chain has matured and none has swept", () => {
        const progress = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "executed" }),
            row({ chainId: "solana-devnet", stage: "executed" }),
        ]);
        expect(progress.stage).toBe("executed");
        expect(progress.waiting).toBe(0);
    });

    it("is swept only when every live chain is", () => {
        const half = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "swept" }),
            row({ chainId: "solana-devnet", stage: "executed" }),
        ]);
        expect(half.stage).toBe("executed");

        const done = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "swept" }),
            row({ chainId: "solana-devnet", stage: "swept" }),
        ]);
        expect(done.stage).toBe("swept");
        expect(done.swept).toBe(2);
    });

    it("does not let a failed chain hold the others back", () => {
        // A chain this build cannot carry through is reported and stepped over. Blocking on it would
        // strand the chains that worked, and the ceremony that produced them cannot be re-run.
        const progress = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "swept" }),
            row({ chainId: "solana-devnet", stage: "failed", failure: "relayer unreachable" }),
        ]);
        expect(progress.stage).toBe("swept");
        expect(progress.failed).toBe(1);
        expect(progress.total).toBe(2);
    });

    it("says failed only when every chain did", () => {
        const progress = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "failed" }),
            row({ chainId: "solana-devnet", stage: "failed" }),
        ]);
        expect(progress.stage).toBe("failed");
    });
});

describe("a re-run must not destroy a live attempt", () => {
    /**
     * The worst bug this file exists to prevent, and one that actually happened.
     *
     * Records are keyed `${vaultId}:${chainId}`, so running a recovery twice over one vault wrote
     * over the first run's rows. A submitted row holds the **intent** — and the key that signed it
     * was wiped on purpose the instant it was used, so nothing can rebuild one. Overwriting it with
     * a failure row left an executable attempt sitting on-chain that this app could no longer reach,
     * because the module only executes an intent byte-identical to the one it was opened with.
     *
     * The second run fails anyway: both chains allow one attempt at a time and refuse another with
     * `AttemptInFlight`. So the cost was pure loss.
     */
    it("keys one row per chain per vault, which is what makes overwriting possible", () => {
        expect(handoverId("v1", "evm-sepolia")).toBe(handoverId("v1", "evm-sepolia"));
    });

    it("treats a row holding an intent as the thing that must survive", () => {
        const live = row({ chainId: "evm-sepolia", stage: "submitted" });
        expect(live.intent).not.toBeNull();
        // What a failed re-run would have written in its place, and why it is unrecoverable.
        const clobbered = { ...live, stage: "failed" as const, intent: null };
        expect(clobbered.intent).toBeNull();
        expect(handoverProgress([clobbered]).stage).toBe("failed");
    });

    it("still reports a vault whose only row was clobbered as needing a fresh start", () => {
        // There is no partial recovery from this: without the intent the attempt can only be
        // aborted or left to expire, so the honest report is that nothing here can be finished.
        const progress = handoverProgress([
            row({ chainId: "evm-sepolia", stage: "failed", intent: null }),
            row({ chainId: "solana-devnet", stage: "failed", intent: null }),
        ]);
        expect(progress.stage).toBe("failed");
        expect(progress.swept).toBe(0);
    });
});

describe("a row, reconciled with the chain", () => {
    /**
     * The bug this pins: a row says `submitted` until this app executes, and the handover view used
     * to render that directly. A matured recovery read "timelock running", and the Move button —
     * disabled while any row was `submitted` — could never be pressed.
     */
    const CLOCK = {
        state: "INITIATED" as const,
        accruedSeconds: 0,
        pausedSeconds: 0,
        checkpointSeconds: 1_000,
        timelockSeconds: 300,
        pauseCeilingSeconds: 900,
    };
    const submitted = row({ chainId: "solana-devnet", stage: "submitted" });
    const attempt = (over: Partial<ChainAttempt> = {}): ChainAttempt => ({
        projected: "INITIATED",
        clock: CLOCK,
        unreadable: null,
        ...over,
    });

    it("reads a matured attempt as ready even though the row still says submitted", () => {
        // Solana's shape: still INITIATED, nothing left to run.
        expect(reconcileHandover(submitted, attempt(), 2_000).stage).toBe("ready");
        // EVM's shape: already EXECUTABLE.
        expect(reconcileHandover(submitted, attempt({ projected: "EXECUTABLE" }), 2_000).stage).toBe(
            "ready",
        );
    });

    it("counts down while the timelock runs", () => {
        const live = reconcileHandover(submitted, attempt(), 1_100);
        expect(live.stage).toBe("counting");
        expect(live.remainingSeconds).toBe(200);
    });

    it("never calls an unread chain ready", () => {
        expect(reconcileHandover(submitted, undefined, 9_999).stage).toBe("unread");
        const failed = reconcileHandover(submitted, attempt({ unreadable: "429" }), 9_999);
        expect(failed.stage).toBe("unread");
        expect(failed.reason).toBe("429");
    });

    it("follows the chain when someone else executed or aborted", () => {
        expect(reconcileHandover(submitted, attempt({ projected: "EXECUTED" }), 2_000).stage).toBe(
            "executed",
        );
        expect(reconcileHandover(submitted, attempt({ projected: "ABORTED" }), 2_000).stage).toBe(
            "aborted",
        );
    });

    it("says so when the chain holds no attempt the row claims was submitted", () => {
        expect(reconcileHandover(submitted, attempt({ projected: null, clock: null }), 2_000).stage).toBe(
            "missing",
        );
    });

    it("keeps the row's word for what this app itself did", () => {
        const swept = row({ chainId: "evm-sepolia", stage: "swept" });
        // Whatever the chain says, a sweep this app sent is a sweep this app sent.
        expect(reconcileHandover(swept, attempt(), 1_100).stage).toBe("swept");
    });

    it("offers Move only the chains it can act on", () => {
        const records = [
            row({ chainId: "evm-sepolia", stage: "submitted" }),
            row({ chainId: "solana-devnet", stage: "submitted" }),
        ];
        const live = [
            reconcileHandover(records[0]!, attempt({ projected: "EXECUTABLE" }), 1_100),
            reconcileHandover(records[1]!, attempt(), 1_100),
        ];
        expect(movableChains(records, live)).toEqual(["evm-sepolia"]);
    });
});

describe("spentFromHandovers", () => {
    /**
     * The bug this pins: the spent mark lived only in React state, so the next reload read the vault
     * as unspent and the seed overview said "recovery ready", green, for a vault already recovered.
     */
    const vault = (id: string, spent: { at: number; reason: string } | null = null) =>
        ({ vaultId: id, spent }) as unknown as import("../src/integration/recovery/vaultRecords.js").VaultRecord;

    it("marks an unspent vault that has a handover row", () => {
        const [fixed] = spentFromHandovers(
            [vault("v1")],
            [row({ chainId: "evm-sepolia", stage: "submitted", submittedAt: 50 }),
             row({ chainId: "solana-devnet", stage: "swept", submittedAt: 40 })],
        );
        expect(fixed!.spent?.at).toBe(40);
    });

    it("leaves vaults without handover rows alone", () => {
        expect(spentFromHandovers([vault("other")], [row({ chainId: "evm-sepolia", stage: "submitted" })])).toEqual([]);
    });

    it("never overwrites a spent mark that was saved properly", () => {
        const saved = vault("v1", { at: 7, reason: "the SDK's own sentence" });
        expect(spentFromHandovers([saved], [row({ chainId: "evm-sepolia", stage: "submitted" })])).toEqual([]);
    });
});
