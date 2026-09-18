/**
 * Running the gate: name the guardians you can reach, then wait for them.
 *
 * A dialog for the same reason sealing is one, plus a sharper one: from the moment it starts, real
 * people have been emailed. It cannot be dismissed while it runs, and the guardians it never asked
 * are shown as prominently as the ones it did — "never contacted" and "declined" are different
 * facts, and only one of them is about the guardian.
 */
import { useState } from "react";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, StatusMessage } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Explain } from "./Explain.js";
import { Notice } from "./Notice.js";

export function RecoverDialog({
    open,
    onClose,
    flow,
    vault,
}: {
    open: boolean;
    onClose: () => void;
    flow: RecoveryFlow;
    vault: VaultRecord;
}) {
    const { state } = flow;
    const gate = vault.gate;
    // Mounted only while it is open (see `RecoveryCard`), so the selection starts empty each time
    // rather than being cleared by an effect.
    const [picked, setPicked] = useState<number[]>([]);
    const running = state.phase === "recovering";
    const complete = picked.length === gate.threshold;

    return (
        <Dialog
            open={open}
            title="Recover this account"
            onClose={onClose}
            // From `Start recovery` onward this has emailed real people; there is no undo to offer.
            dismissible={!running}
            footer={
                state.result !== null ? (
                    <DialogActions>
                        <Button onClick={onClose}>Close</Button>
                    </DialogActions>
                ) : (
                    <DialogActions>
                        <Button onClick={() => void flow.recover(picked)} disabled={!complete || running}>
                            {running
                                ? "Waiting on the guardians…"
                                : complete
                                  ? "Start recovery"
                                  : `Pick ${gate.threshold - picked.length} more`}
                        </Button>
                    </DialogActions>
                )
            }
        >
            <div className="stack">
                <p className="muted">
                    Pick exactly {gate.threshold} of the {gate.subjectCount}.
                </p>

                <div className="gate-picker">
                    {gate.subjects.map((subject) => {
                        const chosen = picked.includes(subject.index);
                        const full = !chosen && picked.length >= gate.threshold;
                        return (
                            <button
                                key={subject.index}
                                type="button"
                                className={chosen ? "gate-option gate-option--active" : "gate-option"}
                                aria-pressed={chosen}
                                // Capped here rather than letting the quorum refuse it minutes later.
                                disabled={full || running || state.result !== null}
                                onClick={() =>
                                    setPicked(
                                        chosen
                                            ? picked.filter((index) => index !== subject.index)
                                            : [...picked, subject.index],
                                    )
                                }
                            >
                                <span className="gate-option__title">{subject.label}</span>
                                <span className="gate-option__gate">
                                    {chosen ? "Will be contacted" : full ? "—" : "Tap to use"}
                                </span>
                            </button>
                        );
                    })}
                </div>

                <Explain>
                    <p>
                        Each one you pick runs a ceremony and waits for a human; the others are never
                        contacted at all, and their share is never requested. That is what a k-of-n
                        buys — not a vote, an absence.
                    </p>
                </Explain>

                {state.members.length > 0 && (
                    <ul className="members">
                        {state.members.map((member) => {
                            const prompt = state.prompts[member.index];
                            return (
                                <li key={member.index}>
                                    <span className="members__who">
                                        #{member.index} {member.label}
                                    </span>
                                    <code>{phaseLabel(member.phase.kind)}</code>
                                    {member.message !== undefined && (
                                        <span className="muted">{member.message}</span>
                                    )}
                                    {prompt !== undefined && (
                                        <span className="row">
                                            <Button onClick={() => flow.answerPrompt(member.index, true)}>
                                                Simulate the reply
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => flow.answerPrompt(member.index, false)}
                                            >
                                                Never answers
                                            </Button>
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {state.result !== null && (
                    <div className="stack">
                        <StatusMessage tone="success">
                            Recovered. The key matches the one this vault registered.
                        </StatusMessage>
                        <p className="mono">{state.result.publicKeyHex}</p>
                        <p className="muted">
                            Contacted: {state.result.contacted.join(", ")} · never contacted:{" "}
                            {state.result.untouched.join(", ") || "none"} — not declined, never asked.
                        </p>
                        {/* Verbatim, never paraphrased: what a recovery costs is the SDK's sentence. */}
                        <Notice tone="caution">{state.result.spentReason}</Notice>
                    </div>
                )}

                {state.log.length > 0 && <pre className="transcript">{state.log.join("\n")}</pre>}

                {state.error !== null && <StatusMessage tone="error">{state.error}</StatusMessage>}
            </div>
        </Dialog>
    );
}

function phaseLabel(kind: string): string {
    switch (kind) {
        case "requesting":
            return "asking…";
        case "awaiting-human":
            return "waiting for a reply";
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
