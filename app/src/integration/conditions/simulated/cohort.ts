/**
 * One simulated adapter instance per guardian, and the counters that make a k-of-n real on screen.
 *
 * A single shared instance would work — the live zkEmail adapter is stateless and `quorumOf` hands
 * the same one to every slot — but it would also make the demo's best lesson unobservable. "Any two
 * of three, and the third is never contacted" is a claim until member #2's recovery counter is
 * sitting at **0** next to the other two at 1. That requires per-member state, so the cohort exists.
 *
 * **To replace:** the whole file, along with the adapter it builds. A live cohort is
 * `quorumOf(zkEmailAdapter, n)` and keeps no state of its own.
 * **Assumes:** indices are the 1-based Shamir indices the quorum uses, and that a caller asking for
 * the same index twice wants the same member — not a fresh one with an empty counter.
 *
 * **Used by the test suite only.** The app runs the live ceremony; this exists so `npm test`
 * stays offline and free, which a suite that bought a seal per run would not be.
 */
import type { ConditionAdapter } from "@nihilium/recovery-core";
import {
    DemoEmailConditionAdapter,
    type DemoMemberStats,
    type HumanStep,
} from "./demoEmailCondition.js";

export interface DemoCohortOptions {
    /**
     * Called where a live ceremony waits on a human. The index identifies which guardian, so a UI can
     * put the prompt on that member's row rather than in a single global banner — members run
     * concurrently, and one banner cannot describe two waits.
     */
    onHumanStep?: (index: number, step: HumanStep) => Promise<void>;
}

export interface DemoCohort {
    /** 1-based. Stable: the same index always returns the same member. */
    adapterFor(index: number): ConditionAdapter;
    /** Sparse by design — a member nobody has touched has no entry, which is itself the answer. */
    stats(): { index: number; stats: DemoMemberStats }[];
    /** Makes one guardian unable to complete a ceremony, so a failed quorum can be demonstrated. */
    setReachable(index: number, reachable: boolean): void;
    reset(): void;
}

export function createDemoCohort(options: DemoCohortOptions = {}): DemoCohort {
    let members = new Map<number, DemoEmailConditionAdapter>();

    const member = (index: number): DemoEmailConditionAdapter => {
        const existing = members.get(index);
        if (existing !== undefined) return existing;
        const created = new DemoEmailConditionAdapter({
            onHumanStep: options.onHumanStep ? (step) => options.onHumanStep!(index, step) : undefined,
        });
        members.set(index, created);
        return created;
    };

    return {
        adapterFor: member,
        stats: () =>
            [...members.entries()]
                .sort(([a], [b]) => a - b)
                .map(([index, adapter]) => ({ index, stats: adapter.stats() })),
        setReachable: (index, reachable) => {
            member(index).reachable = reachable;
        },
        reset: () => {
            members = new Map();
        },
    };
}
