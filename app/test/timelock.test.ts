/**
 * The deadline neither chain stores.
 *
 * Both the EVM module and the Solana program hold an accrual counter and the moment it was last
 * current; the deadline is derived. A wrong derivation does not throw — it produces a plausible
 * number and a UI that says the account is safe when it is not. So the arithmetic is pinned here
 * against the two watchtower adapters' `deadlineFor`, which are the reference implementations.
 */
import { describe, expect, it } from "vitest";
import {
    approximate,
    progressFraction,
    projectTimelock,
    type AttemptClock,
} from "../src/integration/recovery/settlement/timelock.js";

/** The server's defaults: 300s timelock, 900s ceiling (`server/src/config.ts`). */
const BASE: AttemptClock = {
    state: "INITIATED",
    accruedSeconds: 0,
    pausedSeconds: 0,
    checkpointSeconds: 1_000,
    timelockSeconds: 300,
    pauseCeilingSeconds: 900,
};

describe("INITIATED", () => {
    it("matches watchtower-evm: checkpoint + (timelock - accrued)", () => {
        const clock = { ...BASE, accruedSeconds: 120 };
        // 1000 + (300 - 120) = 1180
        expect(projectTimelock(clock, 1_000).executableAt).toBe(1_180);
        expect(projectTimelock(clock, 1_000).remainingSeconds).toBe(180);
    });

    it("counts down as `now` advances, without re-reading the chain", () => {
        const clock = { ...BASE, accruedSeconds: 120 };
        expect(projectTimelock(clock, 1_100).remainingSeconds).toBe(80);
        expect(projectTimelock(clock, 1_179).remainingSeconds).toBe(1);
    });

    it("floors at zero rather than going negative once matured", () => {
        // The chain does not flip to EXECUTABLE at a moment; nothing ticks. So a matured attempt is
        // still reported as INITIATED until something reads it, and a negative remainder here would
        // render as a countdown running backwards.
        const clock = { ...BASE, accruedSeconds: 120 };
        expect(projectTimelock(clock, 9_999).remainingSeconds).toBe(0);
    });

    it("has no ceiling remainder — nothing is holding the clock", () => {
        expect(projectTimelock(BASE, 1_000).ceilingLiftsInSeconds).toBeNull();
    });
});

describe("PAUSED", () => {
    const paused: AttemptClock = {
        ...BASE,
        state: "PAUSED",
        accruedSeconds: 120,
        pausedSeconds: 200,
    };

    it("matches watchtower-evm: ceiling remainder THEN timelock remainder", () => {
        // 1000 + (900 - 200) + (300 - 120) = 1000 + 700 + 180 = 1880
        expect(projectTimelock(paused, 1_000).executableAt).toBe(1_880);
        expect(projectTimelock(paused, 1_000).remainingSeconds).toBe(880);
    });

    it("reports when the ceiling lifts the pause by itself", () => {
        // The bound on the pause authority's power, and the reason the veto is called graduated.
        // 1000 + (900 - 200) = 1700
        expect(projectTimelock(paused, 1_000).ceilingLiftsInSeconds).toBe(700);
    });

    it("keeps counting the ceiling down while the timelock stays frozen", () => {
        const at1500 = projectTimelock(paused, 1_500);
        expect(at1500.ceilingLiftsInSeconds).toBe(200);
        // The remainder shrinks only because the ceiling does; the accrued 120s has not moved.
        expect(at1500.remainingSeconds).toBe(380);
    });

    it("does not under-report by omitting the timelock still to come", () => {
        // The bug this test exists for: showing only the ceiling would promise the account back at
        // 1700 when it is actually 1880 — three minutes of false "ready".
        const { ceilingLiftsInSeconds, remainingSeconds } = projectTimelock(paused, 1_000);
        expect(remainingSeconds).toBeGreaterThan(ceilingLiftsInSeconds!);
    });

    it("survives a pause that has already exhausted its ceiling", () => {
        const spent = { ...paused, pausedSeconds: 900 };
        expect(projectTimelock(spent, 1_000).ceilingLiftsInSeconds).toBe(0);
        expect(projectTimelock(spent, 1_000).remainingSeconds).toBe(180);
    });
});

describe("the stored state must not be swapped for the projected one", () => {
    /**
     * The trap this arithmetic is most likely to be wired into wrongly.
     *
     * A pause whose ceiling has expired lifts with no transaction from anyone, so the *stored* state
     * still says `PAUSED` while `stateOf()` / `projected_state()` correctly answer `INITIATED`. The
     * counters, though, are still the ones written at pause time. Pairing the projected state with
     * the stored counters takes the INITIATED branch and silently drops the ceiling that has already
     * run — reporting the account as recoverable a whole ceiling early.
     */
    const storedAtPause: AttemptClock = {
        ...BASE,
        state: "PAUSED",
        accruedSeconds: 120,
        pausedSeconds: 0,
        checkpointSeconds: 1_000,
    };

    it("gets the right answer from the stored snapshot, whole", () => {
        // 1000 + (900 - 0) + (300 - 120) = 2080
        expect(projectTimelock(storedAtPause, 1_000).executableAt).toBe(2_080);
    });

    it("gets a wrong, earlier answer if the projected state is substituted in", () => {
        const mixed: AttemptClock = { ...storedAtPause, state: "INITIATED" };
        // 1000 + (300 - 120) = 1180 — fifteen minutes early, and it looks perfectly plausible.
        expect(projectTimelock(mixed, 1_000).executableAt).toBe(1_180);
        expect(projectTimelock(mixed, 1_000).executableAt).toBeLessThan(
            projectTimelock(storedAtPause, 1_000).executableAt!,
        );
    });
});

describe("the states with no clock", () => {
    /**
     * Not a degenerate case folded into zero. Both chains' `project()` returns early for these
     * **without touching the checkpoint**, so `checkpointSeconds` is stale storage and arithmetic on
     * it yields a confident, wrong deadline. `null` is the only honest answer.
     */
    const dead = ["EXECUTABLE", "EXECUTED", "ABORTED"] as const;

    it("reports null for every state that is not counting", () => {
        for (const state of dead) {
            const projection = projectTimelock({ ...BASE, state }, 1_000);
            expect(projection.executableAt, state).toBeNull();
            expect(projection.remainingSeconds, state).toBeNull();
        }
    });

    it("reports null when there is no attempt at all", () => {
        expect(projectTimelock({ ...BASE, state: null }, 1_000).remainingSeconds).toBeNull();
    });

    it("does not touch a stale checkpoint to produce a number", () => {
        // A checkpoint from long ago. A deadline computed from it would already have passed, which
        // renders as "ready" — the exact wrong answer for an ABORTED attempt.
        const stale = { ...BASE, state: "ABORTED" as const, checkpointSeconds: 1 };
        expect(projectTimelock(stale, 9_999_999).executableAt).toBeNull();
    });
});

describe("approximate", () => {
    it("never invents precision a human would act on", () => {
        expect(approximate(0)).toBe("now");
        expect(approximate(-5)).toBe("now");
        expect(approximate(1)).toBe("under a minute");
        expect(approximate(59)).toBe("under a minute");
    });

    it("rounds rather than truncating — 119s is nearer two minutes than one", () => {
        expect(approximate(60)).toBe("about 1 minute");
        expect(approximate(119)).toBe("about 2 minutes");
        expect(approximate(300)).toBe("about 5 minutes");
    });

    it("steps up a unit at each boundary", () => {
        expect(approximate(3_599)).toBe("about 60 minutes");
        expect(approximate(3_600)).toBe("about 1 hour");
        expect(approximate(90 * 60)).toBe("about 2 hours");
        expect(approximate(23 * 3600)).toBe("about 23 hours");
        expect(approximate(86_400)).toBe("about 1 day");
        expect(approximate(4 * 86_400)).toBe("about 4 days");
    });

    it("reaches the singular of every unit, so no branch is dead copy", () => {
        expect(approximate(60)).toBe("about 1 minute");
        expect(approximate(3_600)).toBe("about 1 hour");
        expect(approximate(86_400)).toBe("about 1 day");
    });
});

describe("progressFraction", () => {
    /**
     * The bug this exists for: two chains, the same elapsed wait, two different bars.
     *
     * EVM's module reader projects `accruedSeconds` to now before returning it; Solana returns the
     * value stored at `initiate`, which never moves until the next write. Dividing that counter by
     * the timelock — which the meter used to do — therefore filled one bar and left the other at
     * zero for two accounts in identical states.
     */
    const HALFWAY = 1_150; // 150s into a 300s timelock

    it("reads the same for a chain that projects its counter and one that does not", () => {
        const evm: AttemptClock = { ...BASE, accruedSeconds: 150, checkpointSeconds: HALFWAY };
        const solana: AttemptClock = { ...BASE, accruedSeconds: 0, checkpointSeconds: 1_000 };
        expect(progressFraction(evm, HALFWAY)).toBeCloseTo(0.5);
        expect(progressFraction(solana, HALFWAY)).toBeCloseTo(0.5);
    });

    it("is full once the wait is over, whichever way the chain reports it", () => {
        const stale: AttemptClock = { ...BASE, accruedSeconds: 0, checkpointSeconds: 1_000 };
        const executable: AttemptClock = { ...BASE, state: "EXECUTABLE" };
        expect(progressFraction(stale, 2_000)).toBe(1);
        expect(progressFraction(executable, 2_000)).toBe(1);
    });

    it("freezes on the stored counter under a pause, rather than running backwards", () => {
        // `remainingSeconds` under a pause includes the ceiling still to lift, so deriving the fill
        // from it would shrink the bar the moment a pause began.
        const paused: AttemptClock = {
            ...BASE,
            state: "PAUSED",
            accruedSeconds: 150,
            checkpointSeconds: HALFWAY,
        };
        expect(progressFraction(paused, HALFWAY)).toBeCloseTo(0.5);
        // Still half an hour later: the clock is stopped, so the bar is too.
        expect(progressFraction(paused, HALFWAY + 1_800)).toBeCloseTo(0.5);
    });

    it("is null where there is nothing to fill", () => {
        expect(progressFraction({ ...BASE, state: null }, 1_000)).toBeNull();
        expect(progressFraction({ ...BASE, timelockSeconds: 0 }, 1_000)).toBeNull();
    });

    it("never leaves the track", () => {
        const overrun: AttemptClock = { ...BASE, accruedSeconds: 0, checkpointSeconds: 1_000 };
        expect(progressFraction(overrun, 99_999)).toBe(1);
        const future: AttemptClock = { ...BASE, checkpointSeconds: 50_000 };
        const early = progressFraction(future, 1_000);
        expect(early).toBeGreaterThanOrEqual(0);
        expect(early).toBeLessThanOrEqual(1);
    });
});
