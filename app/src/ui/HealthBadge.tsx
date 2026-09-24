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
 * Whether anything is watching for a recovery this browser did not start.
 *
 * `watching` is false everywhere today: the watchtower role is not built. It takes a boolean rather
 * than assuming, so the day it is built this badge starts telling the truth instead of needing to be
 * found and edited.
 */
export function WatchBadge({ watching }: { watching: boolean }) {
    return (
        <span
            className={`stage stage--${watching ? "watched" : "unwatched"}`}
        >
            <span className="stage__dot" aria-hidden="true" />
            {watching ? "Watched" : "No watchtower yet"}
        </span>
    );
}
