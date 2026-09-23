/**
 * Running the gate, and saying where control should end up.
 *
 * Two things were missing and one was wrong. Missing: the **target** — a recovery that hands back a
 * key and stops has not recovered anything, and nothing here ever asked the question the whole
 * mechanism exists for. Missing: the rows — who was asked, what phase they are in, how long it has
 * taken, and what key came out. Wrong: it read as an explanation of a recovery rather than a report
 * of one.
 *
 * The recovered key is the authority that *signs* the handover. The target is where control lands.
 * They are different, they default to different values, and conflating them would hand the account
 * to a key derived from a vault that is now spent.
 */
import { useEffect, useState } from "react";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import type { ChainModule } from "../integration/chains/types.js";
import type { RecoveryChain } from "../demo/useRecoveryChain.js";
import { Button, StatusMessage, TextInput } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Explain } from "./Explain.js";
import { Notice } from "./Notice.js";
import { Transcript } from "./Transcript.js";
import { RecoveredKey } from "./RecoveredKey.js";

export interface RecoveryTarget {
    kind: "derived" | "pasted";
    address: string;
}

/**
 * 0.0002 ETH, sent back to the target itself.
 *
 * Small enough that a demo account can afford the gesture, real enough that it is a transfer rather
 * than a no-op: a zero-value UserOp would prove the signature was accepted and nothing about
 * spending.
 */
const PROOF_AMOUNT_WEI = 200_000_000_000_000n;
const PROOF_AMOUNT_LABEL = "0.0002 ETH";

export function RecoverDialog({
    open,
    onClose,
    flow,
    vault,
    chain,
    /** A fresh account from the demo seed — "the new device". Absent until the wallet has derived it. */
    suggestedTarget,
    onchain,
}: {
    open: boolean;
    onClose: () => void;
    flow: RecoveryFlow;
    vault: VaultRecord;
    chain: ChainModule;
    suggestedTarget:
        | {
              address: string;
              derivationPath: string;
              exportPrivateKeyHex_DEMO_ONLY: () => string;
          }
        | undefined;
    /** The on-chain half. Separate hook, separate failures — see `useRecoveryChain`. */
    onchain: RecoveryChain;
}) {
    const { state } = flow;
    const gate = vault.gate;
    // Mounted only while it is open (see `RecoveryCard`), so every field starts fresh each run.
    const [picked, setPicked] = useState<number[]>([]);
    const [useSuggested, setUseSuggested] = useState(true);
    const [pastedTarget, setPastedTarget] = useState("");
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const running = state.phase === "recovering";
    const complete = picked.length === gate.threshold;
    const target = useSuggested ? (suggestedTarget?.address ?? "") : pastedTarget.trim();
    const targetValid = /^0x[0-9a-fA-F]{40}$/.test(target);

    // One timer for the whole table rather than one per row: the elapsed column is the only thing
    // that changes between ticks, and n intervals to render n cells is n times the re-renders.
    useEffect(() => {
        if (!running) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running]);

    function start(): void {
        setStartedAt(Date.now());
        void flow.recover(picked);
    }

    function close(): void {
        // The key does not outlive the screen that needed it.
        flow.forgetKey();
        onchain.reset();
        onClose();
    }

    const material = state.result?.material ?? null;
    const submitting =
        onchain.state.phase !== "idle" &&
        onchain.state.phase !== "failed" &&
        onchain.state.phase !== "done";

    return (
        <Dialog
            open={open}
            title="Recover this account"
            onClose={close}
            // From `Start recovery` onward this has emailed real people; there is no undo to offer.
            dismissible={!running}
            footer={
                state.result !== null ? (
                    <DialogActions>
                        <Button onClick={close}>Close</Button>
                    </DialogActions>
                ) : (
                    <DialogActions>
                        <Button
                            onClick={start}
                            disabled={!complete || !targetValid || running}
                        >
                            {running
                                ? "Waiting on the guardians…"
                                : !complete
                                  ? `Pick ${gate.threshold - picked.length} more`
                                  : !targetValid
                                    ? "Name where control should go"
                                    : "Start recovery"}
                        </Button>
                    </DialogActions>
                )
            }
        >
            <div className="stack">
                {state.result === null && (
                    <>
                        <div className="field">
                            <span className="field__label">
                                Ask {gate.threshold} of {gate.subjectCount}
                            </span>
                            <div className="gate-picker">
                                {gate.subjects.map((subject) => {
                                    const chosen = picked.includes(subject.index);
                                    const full = !chosen && picked.length >= gate.threshold;
                                    return (
                                        <button
                                            key={subject.index}
                                            type="button"
                                            className={
                                                chosen
                                                    ? "gate-option gate-option--active"
                                                    : "gate-option"
                                            }
                                            aria-pressed={chosen}
                                            // Capped here rather than letting the quorum refuse it
                                            // minutes later.
                                            disabled={full || running}
                                            onClick={() =>
                                                setPicked(
                                                    chosen
                                                        ? picked.filter((i) => i !== subject.index)
                                                        : [...picked, subject.index],
                                                )
                                            }
                                        >
                                            <span className="gate-option__title">
                                                #{subject.index} {subject.label}
                                            </span>
                                            <span className="gate-option__gate">
                                                {chosen
                                                    ? "will be emailed"
                                                    : full
                                                      ? "—"
                                                      : "tap to use"}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="field">
                            <span className="field__label">Recover to</span>
                            <label className="row">
                                <input
                                    type="radio"
                                    name="target"
                                    checked={useSuggested}
                                    disabled={running || suggestedTarget === undefined}
                                    onChange={() => setUseSuggested(true)}
                                />
                                <span>A new key on this device</span>
                                <code className="mono muted">
                                    {suggestedTarget?.address ?? "deriving…"}
                                </code>
                            </label>
                            <label className="row">
                                <input
                                    type="radio"
                                    name="target"
                                    checked={!useSuggested}
                                    disabled={running}
                                    onChange={() => setUseSuggested(false)}
                                />
                                <span>An address I paste</span>
                            </label>
                            {!useSuggested && (
                                <TextInput
                                    value={pastedTarget}
                                    ariaLabel="Recovery target address"
                                    placeholder="0x…"
                                    onChange={(event) => setPastedTarget(event.target.value)}
                                    disabled={running}
                                />
                            )}
                        </div>

                        <Explain>
                            <p>
                                This is the address that ends up controlling the account. It is
                                deliberately <em>not</em> the recovered key: that key signs the
                                handover, and it comes from a vault this recovery spends. Handing
                                control to it would hand control to something derived from a secret
                                the ceremony just exposed.
                            </p>
                            <p>
                                Each guardian you pick runs a ceremony and waits for a human; the
                                others are never contacted at all, and their share is never
                                requested. That is what a k-of-n buys — not a vote, an absence.
                            </p>
                        </Explain>
                    </>
                )}

                {state.members.length > 0 && (
                    <table className="members-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>guardian</th>
                                <th>phase</th>
                                <th>elapsed</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.members.map((member) => {
                                const asked = member.phase.kind !== "idle";
                                return (
                                    <tr key={member.index} data-contacted={String(asked)}>
                                        <td>{member.index}</td>
                                        <td>{member.label}</td>
                                        <td>
                                            {phaseLabel(member.phase.kind)}
                                            {member.message !== undefined && (
                                                <>
                                                    {" "}
                                                    <span className="muted">{member.message}</span>
                                                </>
                                            )}
                                        </td>
                                        <td>
                                            {asked && startedAt !== null
                                                ? elapsed(startedAt, now)
                                                : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}

                {state.result !== null && (
                    <>
                        <RecoveredKey
                            algorithm={state.result.algorithm}
                            publicKeyHex={state.result.publicKeyHex}
                            address={null}
                            material={state.result.material}
                            matchesVault
                            contacted={state.result.contacted}
                            untouched={state.result.untouched}
                        />
                        {/* The SDK's own sentence, verbatim: what a recovery cost. */}
                        <Notice tone="caution">{state.result.spentReason}</Notice>
                        <StatusMessage tone="success">
                            The vault is open and the key is yours. The account has <strong>not</strong>{" "}
                            changed hands — that is the on-chain step, below.
                        </StatusMessage>

                        <dl className="rows">
                            <dt>hands control to</dt>
                            <dd>{target || "—"}</dd>
                            {onchain.state.intentHash !== null && (
                                <>
                                    <dt>intent hash</dt>
                                    <dd>{onchain.state.intentHash}</dd>
                                </>
                            )}
                            {onchain.attempt !== null && (
                                <>
                                    <dt>on-chain</dt>
                                    <dd>
                                        {onchain.attempt.state ?? "no attempt"} ·{" "}
                                        {String(onchain.attempt.accruedSeconds)}s accrued
                                    </dd>
                                </>
                            )}
                        </dl>

                        {onchain.state.problems.map((problem) => (
                            <StatusMessage
                                key={problem.code}
                                tone={problem.blocking ? "error" : "success"}
                            >
                                {problem.message}
                            </StatusMessage>
                        ))}

                        <div className="row">
                            {onchain.state.phase === "waiting" ||
                            onchain.state.phase === "executing" ? (
                                <Button
                                    onClick={() => void onchain.execute()}
                                    disabled={
                                        onchain.attempt?.state !== "EXECUTABLE" ||
                                        onchain.state.phase === "executing"
                                    }
                                >
                                    {onchain.state.phase === "executing"
                                        ? "Executing…"
                                        : onchain.attempt?.state === "EXECUTABLE"
                                          ? `Execute on ${chain.label}`
                                          : "Timelock running…"}
                                </Button>
                            ) : onchain.state.phase === "done" ||
                              onchain.state.phase === "proving" ||
                              onchain.state.phase === "proved" ? (
                                <div className="stack">
                                    <StatusMessage tone="success">
                                        Control moved to {target}.
                                    </StatusMessage>

                                    {/* A fact about this run, so it stays visible: the recovery
                                        added a way in, it did not close the old one. */}
                                    <Notice tone="caution">
                                        The lost key is still an owner of this Safe and can still act
                                        through <code>execTransaction</code>. Recovery installed a
                                        second path; it removed nothing.
                                    </Notice>

                                    {onchain.state.phase === "proved" ? (
                                        <StatusMessage tone="success">
                                            {PROOF_AMOUNT_LABEL} left the account, signed by the new
                                            key. The account is spendable again.
                                        </StatusMessage>
                                    ) : (
                                        <Button
                                            onClick={() =>
                                                suggestedTarget !== undefined &&
                                                void onchain.proveControl({
                                                    to: suggestedTarget.address as `0x${string}`,
                                                    amount: PROOF_AMOUNT_WEI,
                                                    newOwnerPrivateKeyHex:
                                                        suggestedTarget.exportPrivateKeyHex_DEMO_ONLY(),
                                                })
                                            }
                                            disabled={
                                                onchain.state.phase === "proving" ||
                                                !useSuggested ||
                                                suggestedTarget === undefined
                                            }
                                        >
                                            {onchain.state.phase === "proving"
                                                ? "Sending…"
                                                : !useSuggested
                                                  ? "Control is with a key this demo does not hold"
                                                  : `Prove it: send ${PROOF_AMOUNT_LABEL} as the new owner`}
                                        </Button>
                                    )}

                                    <Explain>
                                        <p>
                                            The new key does not replace the Safe's owners — it owns
                                            an ERC-7579 validator the recovery installed. A Safe
                                            picks which validator checks a UserOp from the
                                            operation's <em>nonce key</em>, so this send routes to
                                            that validator rather than to the owner signature the
                                            wallet normally uses.
                                        </p>
                                        <p>
                                            Closing the old path is a separate decision and a
                                            separate transaction: the new owner can call{" "}
                                            <code>swapOwner</code> on the Safe. This demo stops
                                            here, because "recovery covers loss, not theft" — the
                                            lost key is lost, not hostile.
                                        </p>
                                    </Explain>
                                </div>
                            ) : (
                                <Button
                                    onClick={() =>
                                        material !== null &&
                                        void onchain.initiate({
                                            target: target as `0x${string}`,
                                            material,
                                        })
                                    }
                                    disabled={
                                        !onchain.supported ||
                                        material === null ||
                                        !targetValid ||
                                        submitting
                                    }
                                >
                                    {!onchain.supported
                                        ? `No settlement on ${chain.label}`
                                        : material === null
                                          ? "The key has been dropped"
                                          : submitting
                                            ? "Submitting…"
                                            : `Initiate on ${chain.label}`}
                                </Button>
                            )}
                        </div>

                        <Transcript
                            lines={onchain.state.log}
                            // Every phase between starting and settling. `waiting` is the timelock,
                            // which is the slowest of them and the one most worth showing as "still
                            // going" rather than as a finished log.
                            running={submitting}
                            label="On-chain"
                        />
                        {onchain.state.error !== null && (
                            <StatusMessage tone="error">{onchain.state.error}</StatusMessage>
                        )}
                    </>
                )}

                {/* This operation's transcript only. A shared one showed the seal's lines here. */}
                <Transcript
                    lines={state.logs.recover}
                    running={running}
                    label="Recovering"
                />

                {state.error !== null && <StatusMessage tone="error">{state.error}</StatusMessage>}
            </div>
        </Dialog>
    );
}

function phaseLabel(kind: string): string {
    switch (kind) {
        case "requesting":
            return "asking";
        case "awaiting-human":
            return "awaiting reply";
        case "proving":
            return "proving";
        case "done":
            return "done";
        case "failed":
            return "failed";
        default:
            return "not contacted";
    }
}

function elapsed(from: number, to: number): string {
    const seconds = Math.max(0, Math.floor((to - from) / 1000));
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
