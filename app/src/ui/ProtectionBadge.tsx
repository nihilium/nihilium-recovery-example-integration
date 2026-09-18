/**
 * The protection state, at two sizes: a pill on a card, a dot on a tab.
 *
 * `protection.ts` decides what the state *is*; this file only draws it. The shape carries the
 * meaning as well as the colour — hollow, half-filled, filled — so the distinction survives a
 * greyscale screenshot and a reader who cannot separate the two.
 */
import { PROTECTION_LABELS, type Protection } from "./protection.js";

export function ProtectionBadge({ state }: { state: Protection }) {
    return (
        <span className={`protection protection--${state}`}>
            <span className="protection__dot" aria-hidden="true" />
            {PROTECTION_LABELS[state]}
        </span>
    );
}

/** The same fact at tab size, so switching chains shows at a glance which are covered. */
export function ProtectionDot({ state }: { state: Protection }) {
    return (
        <span
            className={`protection__dot protection__dot--${state}`}
            role="img"
            aria-label={PROTECTION_LABELS[state]}
            title={PROTECTION_LABELS[state]}
        />
    );
}
