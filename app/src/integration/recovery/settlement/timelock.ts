/**
 * How long until a recovery can be executed — the one calculation, for every chain.
 *
 * **Neither chain stores a deadline.** Both hold an accrual counter (`accruedSeconds` toward
 * `timelockSeconds`) and the moment it was last brought up to date, and both apply the clock lazily:
 * a chain has no tick, so nothing happens at the moment a timelock matures. The deadline is always
 * derived, and deriving it wrongly produces a confident number rather than an error — which is why
 * it is derived in exactly one place.
 *
 * The EVM module and the Solana program run the same state machine (`GradualVeto`, ported to
 * Solidity and Rust from one spec), so the inputs are identical on both and this file does not know
 * which chain it is serving. It mirrors `deadlineFor` in `@nihilium/recovery-watchtower-evm` and
 * `-solana`, which are the reference implementations; `timelock.test.ts` pins this against their
 * vectors so the three cannot drift.
 *
 * **A pause is not a stop.** `pauseCeilingSeconds` bounds how long the pause authority can hold the
 * clock, and the ceiling lifts by itself with no transaction from anyone. So the wait under `PAUSED`
 * is the ceiling remainder *plus* the timelock remainder, and a UI that showed only the first would
 * promise the account back too early.
 *
 * **To replace:** nothing. This is the protocol's arithmetic, not a product decision.
 * **Assumes:** the four inputs are **one consistent snapshot** — `state` is the state that
 * `accruedSeconds` and `pausedSeconds` belong to, as of `checkpointSeconds`. Each chain hands one
 * over whole, and the only way to get this wrong is to assemble it from two reads:
 *
 * - **EVM:** `attemptOf()` runs `project()` before returning, so its state *and* counters *and*
 *   `checkpointTime` are all current as of the block. Pass that triple verbatim.
 * - **Solana:** the account is raw storage, last written whenever an instruction touched it. Its
 *   state and counters are equally old, so they are consistent with each other. Pass that verbatim
 *   too — do **not** substitute `projected_state`.
 *
 * That last sentence is the trap. A pause past its ceiling still stores `PAUSED`, and
 * `projected_state` correctly reports `INITIATED`; pairing that projected state with the stored
 * counters takes the `INITIATED` branch and drops the ceiling remainder that has already elapsed,
 * reporting the account as recoverable a full ceiling early. The projected state is for telling the
 * user where they are and for gating execute — never for this arithmetic.
 */
import type { VetoState } from "@nihilium/recovery-core";

export interface AttemptClock {
    /**
     * The state the counters below belong to. `null` where no attempt exists.
     *
     * **Not** a projected state read separately — see the header. It travels in the same struct as
     * the counters precisely so that the two cannot be sourced from different reads.
     */
    state: VetoState | null;
    /** Seconds accrued toward `timelockSeconds`, as of `checkpointSeconds`. */
    accruedSeconds: number;
    /** Seconds spent in the current pause, as of `checkpointSeconds`. */
    pausedSeconds: number;
    /** When `state` and the two counters above were all current, together. */
    checkpointSeconds: number;
    timelockSeconds: number;
    pauseCeilingSeconds: number;
}

export interface TimelockProjection {
    /** Unix seconds at which `executeRecovery` becomes legal. `null` where no clock is running. */
    executableAt: number | null;
    /** Seconds until then, floored at zero. `null` where no clock is running. */
    remainingSeconds: number | null;
    /**
     * Under `PAUSED`, seconds until the ceiling lifts the pause on its own. `null` otherwise.
     *
     * Separate from `remainingSeconds` because it is the number that bounds the pause authority's
     * power, and the whole argument for a *graduated* veto is that the bound exists.
     */
    ceilingLiftsInSeconds: number | null;
}

const NO_CLOCK: TimelockProjection = {
    executableAt: null,
    remainingSeconds: null,
    ceilingLiftsInSeconds: null,
};

/**
 * `NONE`, `EXECUTABLE` and the two terminal states have no clock, and that is not a degenerate case
 * to fold into zero: both chains' `project()` returns early for them **without touching the
 * checkpoint**, so it is stale storage there and arithmetic on it would produce a confident, wrong
 * answer. `null` says "there is nothing counting", which is what the caller has to render.
 */
export function projectTimelock(clock: AttemptClock, nowSeconds: number): TimelockProjection {
    if (clock.state === "INITIATED") {
        const executableAt =
            clock.checkpointSeconds + (clock.timelockSeconds - clock.accruedSeconds);
        return {
            executableAt,
            remainingSeconds: Math.max(0, executableAt - nowSeconds),
            ceilingLiftsInSeconds: null,
        };
    }

    if (clock.state === "PAUSED") {
        const ceilingRemainder = clock.pauseCeilingSeconds - clock.pausedSeconds;
        const liftsAt = clock.checkpointSeconds + ceilingRemainder;
        const executableAt = liftsAt + (clock.timelockSeconds - clock.accruedSeconds);
        return {
            executableAt,
            remainingSeconds: Math.max(0, executableAt - nowSeconds),
            ceilingLiftsInSeconds: Math.max(0, liftsAt - nowSeconds),
        };
    }

    return NO_CLOCK;
}

/**
 * A duration a human can hold, and deliberately never a countdown.
 *
 * A recovery is slow for reasons a second hand cannot express — it finishes when the chain says so,
 * and on the way there it waited on guardians answering their email. Ticking a precise number down
 * would suggest a precision the system does not have and would make the wait feel like a bug rather
 * than the design. The same argument made `Transcript`'s progress bar indeterminate.
 *
 * Rounds rather than truncates: 119 seconds is nearer two minutes than one, and "about" has already
 * said this is not exact. Each unit's range starts at one of itself — a boundary at 90 minutes would
 * read "about 60 minutes" where a person says "about an hour", and would make "about 1 hour" and
 * "about 1 day" unreachable strings.
 */
/**
 * Whether `executeRecovery` is legal now — **the** definition, used by every surface that says
 * "ready".
 *
 * There were three, and they disagreed. The chains phrase a matured attempt differently: EVM's
 * reader projects its counters and answers `EXECUTABLE`; Solana answers `INITIATED` with nothing
 * left to run. The timelock box read one spelling, the recovery badge read only the state word, and
 * the handover view read neither — it trusted its own row, which says `submitted` until this app
 * executes, and so kept the Move button disabled after the chain was ready.
 *
 * `projected` answers "is it over?" where the chain says so; otherwise the remainder decides. A
 * pause whose ceiling has not lifted always has time left by construction, so it is never ready.
 * Terminal states are not "ready": there is nothing left to execute.
 */
export function hasMatured(
    projected: VetoState | null,
    clock: AttemptClock | null,
    nowSeconds: number,
): boolean {
    if (projected === "EXECUTABLE") return true;
    if ((projected !== "INITIATED" && projected !== "PAUSED") || clock === null) return false;
    const { remainingSeconds } = projectTimelock(clock, nowSeconds);
    return remainingSeconds !== null && remainingSeconds <= 0;
}

/**
 * How much of the timelock has actually run, `0`..`1`. `null` where there is nothing to fill.
 *
 * **Deliberately not `accruedSeconds / timelockSeconds`**, which is what the meter used to compute.
 * That counter is a snapshot as of `checkpointSeconds`, and the two chains write it differently:
 * EVM's reader projects it to now before handing it over, so its bar filled, while Solana returns
 * the value stored at `initiate` — still zero — so its bar sat empty beside a row that said
 * "ready". The remainder is the one quantity both chains agree on, so the fill is derived from it.
 *
 * **A pause keeps the stored counter**, and that is the exception rather than an oversight.
 * `remainingSeconds` under a pause includes the ceiling still to lift, so deriving the fill from it
 * would run the bar *backwards* when a pause starts. The clock genuinely is stopped, and a frozen
 * bar is the honest picture of that.
 */
export function progressFraction(clock: AttemptClock, nowSeconds: number): number | null {
    // No attempt, or a chain that reports no timelock at all: an empty track, not a full one.
    if (clock.state === null || clock.timelockSeconds <= 0) return null;
    if (clock.state === "PAUSED") return clamp01(clock.accruedSeconds / clock.timelockSeconds);

    const { remainingSeconds } = projectTimelock(clock, nowSeconds);
    // No clock left to run — EXECUTABLE, EXECUTED, ABORTED. The wait is over however it ended.
    if (remainingSeconds === null) return 1;
    return clamp01((clock.timelockSeconds - remainingSeconds) / clock.timelockSeconds);
}

function clamp01(value: number): number {
    if (Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

export function approximate(seconds: number): string {
    if (seconds <= 0) return "now";
    if (seconds < 60) return "under a minute";
    if (seconds < 3600) return plural(Math.round(seconds / 60), "minute");
    if (seconds < 86_400) return plural(Math.round(seconds / 3600), "hour");
    return plural(Math.round(seconds / 86_400), "day");
}

function plural(count: number, unit: string): string {
    return `about ${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** Unix seconds. Both chains' clocks are in seconds, so nothing downstream handles milliseconds. */
export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * The timelock lengths offered when sealing.
 *
 * A short list rather than a free field: the value is written into every chain's veto config at
 * protect time and cannot be changed without re-sealing, so each option should be one a user means.
 * Five minutes is the operator's demo default, kept so a full recovery can be watched end to end.
 */
export const TIMELOCK_CHOICES: readonly { seconds: number; label: string }[] = [
    { seconds: 300, label: "5 minutes" },
    { seconds: 3_600, label: "1 hour" },
    { seconds: 86_400, label: "1 day" },
    { seconds: 604_800, label: "7 days" },
];

export const DEFAULT_TIMELOCK_SECONDS = 300;

/** "1 day", or the plain approximation for a value not on the list. */
export function timelockLabel(seconds: number): string {
    return TIMELOCK_CHOICES.find((choice) => choice.seconds === seconds)?.label ?? approximate(seconds);
}
