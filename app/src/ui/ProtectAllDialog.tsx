/**
 * Protecting every chain that needs it, in one press.
 *
 * A `Dialog` because it sends real transactions on every chain it lists, and because the list is the
 * point: which chains it will touch, which it will leave, and why. A button that quietly did four
 * things to three chains would be the version of this worth distrusting.
 *
 * **Skipped chains are shown, with reasons.** They are the half a reader cannot otherwise discover —
 * a chain left unprotected because its balance read as zero, or because this build cannot settle it,
 * looks identical from outside to a chain that is fine.
 */
import { formatAmount } from "../integration/chains/amounts.js";
import type { ProtectTarget, SkippedChain } from "../integration/recovery/settlement/coverage.js";
import type { ProtectAll } from "../demo/useProtectAll.js";
import type { FeeEstimator } from "../demo/useFeeEstimate.js";
import { Button, StatusMessage } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { FeeEstimate } from "./FeeEstimate.js";
import { Notice } from "./Notice.js";
import { Transcript } from "./Transcript.js";

export function ProtectAllDialog({
    open,
    onClose,
    targets,
    skipped,
    protectAll,
    fees,
}: {
    open: boolean;
    onClose: () => void;
    targets: readonly ProtectTarget[];
    skipped: readonly SkippedChain[];
    protectAll: ProtectAll;
    fees: FeeEstimator;
}) {
    const { running, done, log, results } = protectAll;
    const failures = results.filter((row) => row.failure !== null);

    /**
     * Priced for exactly the chains this run would touch, and per chain rather than in aggregate.
     *
     * `update` means the chain already holds a key, which is the same fact as "the account exists" —
     * a Safe with a module installed is deployed, and a registered Solana vault PDA has been
     * created. So one chain being an update says nothing about the other, and the flags that follow
     * from it are worth several times the fee itself: a Safe's first UserOp carries its whole
     * deployment, and a first `create_vault` carries rent.
     */
    const estimate = fees.estimate(
        "protect",
        (chainId) => {
            const target = targets.find((row) => row.chainId === chainId);
            const existing = target?.action === "update";
            return { accountDeployed: existing, replacing: existing, vaultExists: existing };
        },
        targets.map((target) => target.chainId),
    );

    return (
        <Dialog
            open={open}
            title="Protect all chains with funds"
            onClose={onClose}
            // A half-finished sweep across three chains is the worst moment to lose the transcript.
            dismissible={!running}
            footer={
                <DialogActions
                    back={{ label: done ? "Close" : "Cancel", onClick: onClose, disabled: running }}
                >
                    {!done && (
                        <Button
                            onClick={() => void protectAll.run(targets)}
                            disabled={running || targets.length === 0}
                        >
                            {running
                                ? "Protecting…"
                                : targets.length === 1
                                  ? "Protect 1 chain"
                                  : `Protect ${targets.length} chains`}
                        </Button>
                    )}
                </DialogActions>
            }
        >
            <div className="stack">
                {targets.length === 0 ? (
                    <p>All funded chains are protected.</p>
                ) : (
                    <>
                        <div className="stack">
                            {targets.map((target) => (
                                <div className="coverage-row" key={target.chainId}>
                                    <span>{target.chainLabel}</span>
                                    <span className="muted mono">
                                        {/* An unreadable balance is not a zero one, and this is the
                                            screen that decides whether it gets protected. */}
                                        {target.balanceUnknown
                                            ? "balance could not be read"
                                            : `${formatAmount(
                                                  target.balanceRaw ?? 0n,
                                                  target.balanceDecimals ?? 18,
                                              )} ${target.balanceSymbol ?? ""}`}
                                    </span>
                                    <span className="muted">
                                        {target.action === "update"
                                            ? "replace the old gate"
                                            : "register this gate"}
                                    </span>
                                    <span className="mono">{outcomeOf(protectAll, target.chainId)}</span>
                                </div>
                            ))}
                        </div>

                        {!done && <FeeEstimate estimate={estimate} fees={fees} />}
                    </>
                )}

                {skipped.length > 0 && (
                    <div className="stack">
                        <span className="field__label">Not touched</span>
                        {skipped.map((row) => (
                            <div className="coverage-row" key={row.chainId}>
                                <span>{row.chainLabel}</span>
                                <span className="muted">{row.reason}</span>
                            </div>
                        ))}
                    </div>
                )}

                {log.length > 0 && <Transcript lines={log} running={running} label="Protecting" />}

                {done && failures.length === 0 && results.length > 0 && (
                    <StatusMessage tone="success">
                        All listed chains protected.
                    </StatusMessage>
                )}
                {done && failures.length > 0 && (
                    <Notice tone="caution">
                        {failures.length} of {results.length} failed. Close and press Protect all
                        chains again to retry them.
                    </Notice>
                )}
            </div>
        </Dialog>
    );
}

function outcomeOf(protectAll: ProtectAll, chainId: string): string {
    const row = protectAll.results.find((result) => result.chainId === chainId);
    if (row === undefined) return protectAll.running ? "…" : "";
    return row.failure === null ? "done" : "failed";
}
