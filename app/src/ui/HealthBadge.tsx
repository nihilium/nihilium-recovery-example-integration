/**
 * The recovery's stage, at badge size — and the watchtower's answer beside it.
 *
 * Two badges, because they answer two questions. The stage says what has happened to *this* account
 * as far as the chain and this browser know. The watch badge says whether anything would notice a
 * recovery somebody else started, and its resting state is "nothing is watching" — never a tick,
 * because a green mark over an unmonitored vault is the misreading the whole rule exists to stop.
 *
 * `recoveryHealth.ts` decides what the states are; this only draws them.
 */
import type { WatchView } from "../integration/recovery/watch.js";
import { STAGE_LABELS, type RecoveryStage } from "./recoveryHealth.js";

export function StageBadge({ stage }: { stage: RecoveryStage }) {
    return (
        <span className={`stage stage--${stage}`}>
            <span className="stage__dot" aria-hidden="true" />
            {STAGE_LABELS[stage]}
        </span>
    );
}

/**
 * What the watchtower says about this vault.
 *
 * Four states and only one of them green. `unknown` covers every answer the watchtower cannot vouch
 * for — never polled, degraded, unreachable — and it is drawn as its own state rather than folded
 * into "Watched", because a broken watcher that looks like a quiet one is the failure this exists
 * to prevent.
 */
const WATCH_LABELS: Record<WatchView["state"], string> = {
    off: "No watchtower",
    watching: "Watched",
    alarm: "Recovery attempt detected",
    unknown: "Watch status unknown",
};

export function WatchBadge({ view }: { view: WatchView }) {
    return (
        <span className={`stage stage--watch-${view.state}`} title={view.message}>
            <span className="stage__dot" aria-hidden="true" />
            {WATCH_LABELS[view.state]}
        </span>
    );
}
