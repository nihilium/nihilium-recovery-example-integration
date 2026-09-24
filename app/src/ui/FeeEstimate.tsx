/**
 * What an operation costs on chain, beside the button that starts it.
 *
 * The headline is one number; everything that makes it up is in the panel, because the split is the
 * part worth reading. Most of these fees are not paid by the wallet — the relayer carries initiate
 * and execute on both chains — and a total that hid that would make recovery look free to run.
 *
 * Two things this must never do, both of which read as good news:
 * a missing price must not render as `$0.00`, and a chain that sends nothing must not vanish from
 * the breakdown. Both are handled in `estimate.ts` and reported here by name.
 */
import { formatAge, formatUsd } from "../integration/costs/format.js";
import type { CostEstimate } from "../integration/costs/estimate.js";
import type { FeeEstimator } from "../demo/useFeeEstimate.js";
import { Tooltip } from "./Tooltip.js";

export function FeeEstimate({ estimate, fees }: { estimate: CostEstimate; fees: FeeEstimator }) {
    if (fees.loading) return <span className="fee muted">estimating fees…</span>;

    const total = estimate.totalUsdMicros;
    // The protocol fee is in USD already, so it is stated even when the gas could not be priced.
    const protocol =
        estimate.protocolUsdMicros > 0n ? ` + ${formatUsd(estimate.protocolUsdMicros)} protocol fee` : "";
    const headline =
        total === null
            ? `fees in ETH and SOL — no USD price${protocol}`
            : `≈ ${formatUsd(total)} in fees${estimate.basis === "assumed" ? ", in part assumed" : ""}`;

    return (
        <span className="fee">
            <span className="fee__headline">{headline}</span>
            <Tooltip
                label="Fee breakdown, per chain"
                panel={
                    <Breakdown
                        estimate={estimate}
                        error={fees.error}
                        readAt={fees.readAtSeconds}
                    />
                }
            >
                <span aria-hidden="true">ⓘ</span>
            </Tooltip>
        </span>
    );
}

function Breakdown({
    estimate,
    error,
    readAt,
}: {
    estimate: CostEstimate;
    error: string | null;
    readAt: number;
}) {
    return (
        <span className="fee-panel">
            {estimate.rows.map((row) => (
                <span className="fee-panel__chain" key={row.chainId}>
                    <span className="fee-panel__row fee-panel__row--head">
                        <span>{row.chainLabel}</span>
                        <span className="mono">
                            {/* A chain this build does not settle. Said, not omitted: a chain
                                missing from a breakdown is a total that is wrong without looking
                                wrong. */}
                            {!row.transacts
                                ? "no transaction"
                                : row.feeUsdMicros === null
                                  ? "—"
                                  : formatUsd(row.feeUsdMicros)}
                        </span>
                    </span>

                    {row.unreadable !== null && (
                        <span className="fee-panel__note">could not be read: {row.unreadable}</span>
                    )}

                    {row.steps.map((step, index) => (
                        <span className="fee-panel__step" key={`${step.label}-${index}`}>
                            <span className="fee-panel__row">
                                <span>{step.label}</span>
                                <span className="fee-panel__payer">{step.payer}</span>
                                <span className="mono">
                                    {step.feeUsdMicros === null
                                        ? step.feeNative
                                        : formatUsd(step.feeUsdMicros)}
                                </span>
                            </span>
                            {/* Rent is a deposit, not a fee: it comes back when the account closes,
                                so it is named and kept out of the total above. */}
                            {step.depositNative !== null && (
                                <span className="fee-panel__row">
                                    <span>rent, refundable</span>
                                    <span className="fee-panel__payer">{step.payer}</span>
                                    <span className="mono">
                                        {step.depositUsdMicros === null
                                            ? step.depositNative
                                            : formatUsd(step.depositUsdMicros)}
                                    </span>
                                </span>
                            )}
                            {/* Only where the number is a guess. Which ones are measured and which
                                are not is the difference between a figure and a claim. */}
                            {step.basis === "assumed" && (
                                <span className="fee-panel__note">assumed</span>
                            )}
                        </span>
                    ))}
                </span>
            ))}

            {estimate.protocolFees.map((fee) => (
                <span className="fee-panel__chain" key={fee.label}>
                    <span className="fee-panel__row">
                        <span>{fee.label}</span>
                        <span className="fee-panel__payer">{fee.payer}</span>
                        <span className="mono">{formatUsd(fee.usdMicros)}</span>
                    </span>
                    {/* Priced, not collected: nothing in this demo charges it. */}
                    <span className="fee-panel__note">{fee.term} · not charged in this demo</span>
                </span>
            ))}

            {estimate.byPayer.length > 0 && (
                <span className="fee-panel__chain">
                    {estimate.byPayer.map((share) => (
                        <span className="fee-panel__row" key={share.payer}>
                            <span>{share.payer} pays</span>
                            <span className="mono">{formatUsd(share.usdMicros)}</span>
                        </span>
                    ))}
                </span>
            )}

            {estimate.depositUsdMicros !== null && estimate.depositUsdMicros > 0n && (
                <span className="fee-panel__note">
                    plus {formatUsd(estimate.depositUsdMicros)} in refundable deposits, not counted
                    above
                </span>
            )}

            {/* The line that keeps the number honest. The work is measured on the testnets this app
                runs on; only the price is mainnet's. */}
            <span className="fee-panel__note">
                Testnet work, priced at Ethereum mainnet rates.
            </span>

            {estimate.asOfSeconds !== null ? (
                <span className="fee-panel__note">
                    Chainlink prices, {formatAge(Math.max(0, readAt - estimate.asOfSeconds))} old.
                </span>
            ) : (
                <span className="fee-panel__note">
                    No USD price: {error ?? "the mainnet RPC could not be reached"}
                </span>
            )}
        </span>
    );
}
