/**
 * The watchtower's answer, at badge size.
 *
 * `recoveryHealth.ts` decides what the state is; this only draws it. There is deliberately no
 * success styling — the resting state is "nothing is watching", and a green badge over that would
 * be the exact misreading `unknown never renders as all clear` exists to prevent.
 */
import { HEALTH_DETAIL, HEALTH_LABELS, type RecoveryHealth } from "./recoveryHealth.js";

export function HealthBadge({ state }: { state: RecoveryHealth }) {
    return (
        <span className={`health health--${state}`} title={HEALTH_DETAIL[state]}>
            <span className="health__dot" aria-hidden="true" />
            {HEALTH_LABELS[state]}
        </span>
    );
}
