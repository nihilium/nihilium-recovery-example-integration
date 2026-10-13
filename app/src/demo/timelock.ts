/**
 * The timelock as this demo offers and phrases it. The arithmetic itself — projection, maturity,
 * progress — is the SDK's (`@nihilium/recovery-veto`), re-exported here so the UI has one import.
 */
export {
    hasMatured,
    predatesRegistration,
    progressFraction,
    projectTimelock,
} from "@nihilium/recovery-veto";
export type { ProjectedClock, TimelockProjection } from "@nihilium/recovery-veto";
export type { AttemptClock } from "@nihilium/recovery-core";

/**
 * A duration a human can hold, and deliberately never a countdown: a recovery finishes when the chain
 * says so, and ticking a precise number down would suggest a precision the system does not have.
 */
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
 * The timelock lengths offered when sealing. A short list rather than a free field: the value is
 * written into every chain's veto config at protect time and cannot be changed without re-sealing.
 * Five minutes is the operator's demo default, kept so a full recovery can be watched end to end.
 */
export const TIMELOCK_CHOICES: readonly { seconds: number; label: string; short: string }[] = [
    { seconds: 300, label: "5 minutes", short: "5m" },
    { seconds: 1_800, label: "30 minutes", short: "30m" },
    { seconds: 3_600, label: "1 hour", short: "1h" },
    { seconds: 86_400, label: "1 day", short: "1d" },
    { seconds: 604_800, label: "7 days", short: "7d" },
];

export const DEFAULT_TIMELOCK_SECONDS = 300;

/** "1 day", or the plain approximation for a value not on the list. */
export function timelockLabel(seconds: number): string {
    return TIMELOCK_CHOICES.find((choice) => choice.seconds === seconds)?.label ?? approximate(seconds);
}
