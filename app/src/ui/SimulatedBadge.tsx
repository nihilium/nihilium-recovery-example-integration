/**
 * The badge every simulated value wears.
 *
 * It takes the reason rather than defaulting one, because "simulated" without "simulated how" is
 * the kind of label a reader learns to ignore.
 */
export function SimulatedBadge({ reason }: { reason: string }) {
    return (
        <span className="sim-badge" title={reason}>
            <span className="sim-badge__dot" aria-hidden="true" />
            simulated
            <span className="sim-badge__reason">{reason}</span>
        </span>
    );
}
