/**
 * Setting a gate up: choose it, name the guardians, read the price, buy it.
 *
 * Nothing here knows what an email is. The fields, their validation and their labels all come off
 * `method.kinds`, and the presets carry their own copy — a passport method would render through this
 * same dialog.
 *
 * It is a dialog rather than a panel because this is the rarest thing in the app and the only paid
 * one. Leaving the form on the page made a wallet look like a signup flow, and put an irreversible
 * button permanently in reach.
 */
import { useState } from "react";
import type {
    GatePreset,
    MethodRegistry,
    PreflightVerdict,
    Subject,
} from "../integration/conditions/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { useEmailDomainChecks } from "../demo/useEmailDomainChecks.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, StatusMessage, TextInput } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Explain } from "./Explain.js";
import { Notice } from "./Notice.js";
import { downloadSeal } from "./downloadSeal.js";
import { SealRow } from "./SealRow.js";

/**
 * Prefilled so the demo runs in one click, at *different domains* on purpose — three guardians at
 * one provider is a 2-of-3 whose failure domain is one company, and identical domains would make
 * every member's seal summary read the same, hiding that the summary is per member.
 *
 * Every domain here is one the live DKIM registry answers `eligible` for today. That is not
 * cosmetic: the check below is real, and a default set that blocked its own seal button would read
 * as a broken demo rather than as the lesson. Type `@fastmail.com` into any of them to see the
 * blocking path, which is one keystroke away on purpose.
 */
const SUGGESTED = [
    "alice@gmail.com",
    "bob@proton.me",
    "carol@outlook.com",
    "dan@hotmail.com",
    "erin@gmail.com",
];

type Step = "method" | "gate" | "guardians" | "confirm" | "done";

export function SealDialog({
    open,
    onClose,
    flow,
    methods,
    replacing: replacingNow,
}: {
    open: boolean;
    onClose: () => void;
    flow: RecoveryFlow;
    methods: MethodRegistry;
    /** The vault this ceremony replaces, or null for a first seal. */
    replacing: VaultRecord | null;
}) {
    // Frozen at mount. A successful first seal makes a vault exist, so the live prop would flip to
    // "you are replacing something" on the very step that says the seal succeeded.
    const [replacing] = useState(replacingNow);

    const offers = methods.offers();
    // Only an available offer can be selected, and a registry that exists has at least one — it
    // throws rather than returning an empty one. So `method` below is never actually null.
    const [offerId, setOfferId] = useState(
        () => offers.find((offer) => offer.available)?.id ?? offers[0]!.id,
    );
    const method = methods.require(offerId);

    const kind = method.kinds[0]!;
    const recommended = method.presets.find((option) => option.recommended) ?? method.presets[0]!;

    // Mounted only while it is open (see `RecoveryCard`), so every field below starts fresh on each
    // run — including a re-seal, where the set being replaced is not a starting point for the set
    // replacing it.
    const [local, setStep] = useState<Step>("method");
    const [preset, setPreset] = useState<GatePreset>(recommended);
    const [drafts, setDrafts] = useState<string[]>(() =>
        Array.from({ length: recommended.subjectCount }, (_, i) => SUGGESTED[i] ?? ""),
    );
    const [downloaded, setDownloaded] = useState(false);

    const running = flow.state.phase === "sealing";

    // Parsed on every keystroke, and deliberately not memoized: `checkGate` compares canonical ids,
    // so a duplicate is caught before anything is spent rather than by the quorum, later, after the
    // money. Five regex matches per keystroke is not worth a dependency array that has to stay right.
    const parsed = drafts.map((value) => kind.parse({ kindId: kind.id, values: { email: value } }));
    const subjects: Subject[] = parsed.flatMap((entry) => (entry.ok ? [entry.subject] : []));
    // Aligned to the form's rows, with a hole where a row does not parse yet — the check is per
    // field, and "one of these is not recoverable" is useless without saying which.
    const domains = useEmailDomainChecks(
        kind,
        parsed.map((entry) => (entry.ok ? entry.subject : null)),
    );
    const issues =
        subjects.length === drafts.length
            ? method.checkGate({ subjects, threshold: preset.threshold })
            : [];
    const fieldIssues = parsed.flatMap((entry) => (entry.ok ? [] : entry.issues));
    const named = subjects.length === drafts.length && issues.length === 0 && fieldIssues.length === 0;

    // Derived, not an effect: the ceremony finishing is what advances the last step, and there is no
    // "sealed" the user clicks. Only a run that started *here* counts — reopening the dialog over an
    // already-sealed vault starts at `gate`, because that run is a replacement.
    const step: Step =
        local === "confirm" && flow.state.phase === "sealed" && flow.state.sealFile !== null
            ? "done"
            : local;

    function choosePreset(next: GatePreset): void {
        setPreset(next);
        // Grow or shrink around what is typed: position is the Shamir index, so rebuilding the array
        // would silently renumber guardians.
        setDrafts((prev) =>
            Array.from({ length: next.subjectCount }, (_, i) => prev[i] ?? SUGGESTED[i] ?? ""),
        );
    }

    function start(): void {
        if (replacing === null) void flow.seal(method.id, subjects, preset.threshold);
        else void flow.reseal(method.id, subjects, preset.threshold);
    }

    const vault = flow.active;

    return (
        <Dialog
            open={open}
            title={replacing === null ? "Set up recovery" : "Replace your guardians"}
            onClose={onClose}
            // A paid, multi-guardian ceremony cannot be abandoned by a stray ESC.
            dismissible={!running}
            footer={footerFor()}
        >
            {replacing !== null && step !== "done" && (
                <p className="muted">
                    This buys a new set of seals. Your current gate keeps working until the new one is
                    finished.
                </p>
            )}

            {step === "method" && (
                <div className="stack">
                    <div className="gate-picker">
                        {offers.map((offer) => (
                            <button
                                key={offer.id}
                                type="button"
                                className={
                                    offer.id === offerId
                                        ? "gate-option gate-option--active"
                                        : "gate-option"
                                }
                                // Shown and refused, not hidden: the adapter is real and the reason
                                // it is not wired here is the useful part.
                                disabled={!offer.available}
                                aria-pressed={offer.id === offerId}
                                onClick={() => setOfferId(offer.id)}
                            >
                                <span className="gate-option__title">{offer.label}</span>
                                <span className="gate-option__cost">{offer.blurb}</span>
                                {offer.unavailable !== undefined && (
                                    <span className="gate-option__blocked">{offer.unavailable}</span>
                                )}
                            </button>
                        ))}
                    </div>
                    <Explain>
                        <ul className="reasons">
                            {method.limits.map((limit) => (
                                <li key={limit}>{limit}</li>
                            ))}
                        </ul>
                    </Explain>
                </div>
            )}

            {step === "gate" && (
                <div className="stack">
                    <div className="gate-picker">
                        {method.presets.map((option) => (
                            <button
                                key={option.label}
                                type="button"
                                className={
                                    option.label === preset.label
                                        ? "gate-option gate-option--active"
                                        : "gate-option"
                                }
                                aria-pressed={option.label === preset.label}
                                onClick={() => choosePreset(option)}
                            >
                                <span className="gate-option__title">{option.label}</span>
                                {/* The number never renders alone. */}
                                <span className="gate-option__cost">{option.survives}</span>
                            </button>
                        ))}
                    </div>
                    <Explain>
                        <p>{method.blurb}</p>
                    </Explain>
                </div>
            )}

            {step === "guardians" && (
                <div className="stack">
                    {drafts.map((value, index) => (
                        <div className="field" key={index}>
                            {/* The verdict sits outside this label on purpose: it carries a "check
                                again" button, and a control inside a <label> also activates the
                                field the label names. */}
                            <label className="field__labelled">
                                <span className="field__label">
                                    {preset.subjectCount === 1
                                        ? kind.label
                                        : `${capitalize(kind.noun.one)} ${index + 1} of ${preset.subjectCount}`}
                                </span>
                                <TextInput
                                    type="email"
                                    value={value}
                                    ariaLabel={`${kind.noun.one} ${index + 1}`}
                                    placeholder={kind.fields[0]?.placeholder ?? ""}
                                    onChange={(event) =>
                                        setDrafts((prev) =>
                                            prev.map((entry, i) =>
                                                i === index ? event.target.value : entry,
                                            ),
                                        )
                                    }
                                />
                            </label>
                            <DomainVerdict
                                verdict={domains.verdicts[index]}
                                onRecheck={() => domains.recheck(index)}
                            />
                        </div>
                    ))}

                    {[...fieldIssues, ...issues].map((issue, i) => (
                        <StatusMessage key={i} tone="error">
                            {issue.message}
                        </StatusMessage>
                    ))}

                    <Explain>
                        <p>
                            Each address is checked against the live zkEmail DKIM registry as you type.
                            A domain the registry cannot prove is a guardian whose share could never be
                            opened, so it blocks the seal rather than failing later.
                        </p>
                    </Explain>
                </div>
            )}

            {step === "confirm" && (
                <div className="stack">
                    <ul className="reasons">
                        {subjects.map((subject, i) => (
                            <li key={subject.id}>
                                {i + 1}. {subject.label}
                            </li>
                        ))}
                    </ul>
                    {/* The price, before the button that spends it. This reports, so it always shows. */}
                    <p>{method.cost.describe(preset)}</p>

                    {flow.state.logs.seal.length > 0 && (
                        <pre className="transcript">{flow.state.logs.seal.join("\n")}</pre>
                    )}
                    {flow.state.error !== null && (
                        <StatusMessage tone="error">{flow.state.error}</StatusMessage>
                    )}
                </div>
            )}

            {step === "done" && vault !== null && (
                <div className="stack">
                    <StatusMessage tone="success">
                        Sealed behind {preset.label.toLowerCase()}.
                    </StatusMessage>
                    <p>Download the seal file now. It is the one artifact you have to keep.</p>

                    {/* Said here, at the moment it becomes true, rather than left for the card
                        behind this dialog. A replaced gate that never reaches the chain is a gate
                        the module does not honour — and the one it still honours is the old one. */}
                    {replacing !== null && (
                        <Notice tone="caution">
                            The chain has not changed. It still honours the gate you just replaced,
                            so until you update it the <strong>old</strong> guardians are the ones
                            who can recover this account. The card behind this dialog has the button.
                        </Notice>
                    )}
                    {/* The full seal treatment lives here rather than on the card, because this is
                        the moment the greyed “Mail me the seal” is worth reading — you have just
                        made the thing, and mailing it to a guardian is the next idea you will have. */}
                    <SealRow vault={vault} sealFile={flow.state.sealFile} />
                    <pre className="transcript">{flow.state.logs.seal.join("\n")}</pre>
                    <Explain>
                        <p>
                            The vault exists; the chain has not been told about it. A recovery key no
                            chain has registered protects nothing, and registering it is a separate,
                            on-chain step that costs gas and is paid by the account.
                        </p>
                    </Explain>
                </div>
            )}
        </Dialog>
    );

    function footerFor(): React.ReactNode {
        if (step === "method") {
            return (
                <DialogActions>
                    <Button onClick={() => setStep("gate")}>How many?</Button>
                </DialogActions>
            );
        }
        if (step === "gate") {
            return (
                <DialogActions back={{ label: "Back", onClick: () => setStep("method") }}>
                    <Button onClick={() => setStep("guardians")}>
                        Name {preset.subjectCount} {preset.subjectCount === 1 ? kind.noun.one : kind.noun.many}
                    </Button>
                </DialogActions>
            );
        }
        if (step === "guardians") {
            return (
                <DialogActions back={{ label: "Back", onClick: () => setStep("gate") }}>
                    <Button onClick={() => setStep("confirm")} disabled={!named || domains.blocking}>
                        {domains.blocking ? "Waiting on the domain check" : "Review"}
                    </Button>
                </DialogActions>
            );
        }
        if (step === "confirm") {
            return (
                <DialogActions
                    back={{ label: "Back", onClick: () => setStep("guardians"), disabled: running }}
                >
                    <Button onClick={start} disabled={running || !named}>
                        {running
                            ? `Sealing ${preset.subjectCount} ${kind.noun.many}…`
                            : `Seal behind ${preset.label.toLowerCase()}`}
                    </Button>
                </DialogActions>
            );
        }
        return (
            <DialogActions>
                <Button
                    variant="ghost"
                    onClick={() => {
                        if (vault !== null && flow.state.sealFile !== null) {
                            downloadSeal(vault, flow.state.sealFile);
                            setDownloaded(true);
                        }
                    }}
                >
                    Download the seal
                </Button>
                <Button onClick={onClose}>{downloaded ? "Done" : "Close without downloading"}</Button>
            </DialogActions>
        );
    }
}

/**
 * One guardian's domain verdict, rendered under its own field.
 *
 * Per field rather than once for the form: in a five-guardian set the answers routinely differ, and
 * a single "one of these cannot be recovered" is useless without saying which one.
 */
function DomainVerdict({
    verdict,
    onRecheck,
}: {
    verdict: PreflightVerdict | undefined;
    onRecheck: () => void;
}) {
    if (verdict === undefined) return null;
    if (verdict.status === "checking") {
        return <span className="verdict verdict--checking">{verdict.message}</span>;
    }
    if (verdict.status === "ok") {
        return <span className="verdict verdict--ok">{verdict.message}</span>;
    }
    return (
        <span
            className={
                verdict.status === "blocking" ? "verdict verdict--blocking" : "verdict verdict--warning"
            }
        >
            {verdict.message}
            {verdict.remedy !== undefined && <> {verdict.remedy}</>}{" "}
            <button type="button" className="verdict__recheck" onClick={onRecheck}>
                check again
            </button>
        </span>
    );
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
