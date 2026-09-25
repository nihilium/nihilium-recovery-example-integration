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
import { Fragment, useState } from "react";
import type {
    GatePreset,
    MethodRegistry,
    PreflightVerdict,
    RecoveryMethod,
    Subject,
    SubjectField,
    SubjectVerification,
} from "../integration/conditions/types.js";
import { EMAIL_KIND_ID } from "../integration/conditions/subjects/email.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { useEmailDomainChecks } from "../demo/useEmailDomainChecks.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, Checkbox, StatusMessage, TextInput } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Transcript } from "./Transcript.js";
import { Notice } from "./Notice.js";
import { downloadSeal } from "./downloadSeal.js";
import {
    DEFAULT_TIMELOCK_SECONDS,
    TIMELOCK_CHOICES,
    timelockLabel,
} from "../integration/recovery/settlement/timelock.js";
import { displayRecordId } from "../integration/recovery/vaultRecords.js";
import { AddressChip } from "./AddressChip.js";

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
const SUGGESTED_EMAILS = [
    "alice@gmail.com",
    "bob@proton.me",
    "carol@outlook.com",
    "dan@hotmail.com",
    "erin@gmail.com",
];

type Draft = Readonly<Record<string, string>>;

/**
 * Prefills, by subject kind. Only the email kind gets any: a guardian's address can be anyone's for
 * a demo, but a passport kind commits to a real document, and a made-up name would buy a seal that
 * no passport on earth can open.
 */
function suggestedDraft(kindId: string, index: number): Draft {
    const email = SUGGESTED_EMAILS[index];
    return kindId === EMAIL_KIND_ID && email !== undefined ? { email } : {};
}

function draftsFor(kindId: string, count: number, prev: readonly Draft[] = []): Draft[] {
    return Array.from({ length: count }, (_, i) => prev[i] ?? suggestedDraft(kindId, i));
}

function recommendedPreset(method: RecoveryMethod): GatePreset {
    return method.presets.find((option) => option.recommended) ?? method.presets[0]!;
}

/** A render hint to an input type. The design system's input has no date type; a date is text. */
function inputType(field: SubjectField): "email" | "text" {
    return field.kind === "email" ? "email" : "text";
}

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
    const recommended = recommendedPreset(method);

    // Mounted only while it is open (see `RecoveryCard`), so every field below starts fresh on each
    // run — including a re-seal, where the set being replaced is not a starting point for the set
    // replacing it.
    const [local, setStep] = useState<Step>("method");
    const [preset, setPreset] = useState<GatePreset>(recommended);
    // A replacement starts from the gate it replaces, so re-sealing never quietly shortens it.
    const [timelock, setTimelock] = useState(
        replacingNow?.timelockSeconds ?? DEFAULT_TIMELOCK_SECONDS,
    );
    const [drafts, setDrafts] = useState<Draft[]>(() =>
        draftsFor(kind.id, recommended.subjectCount),
    );
    const [downloaded, setDownloaded] = useState(false);
    /**
     * Per row, the exact lines the user confirmed against their document. Keyed by the lines rather
     * than a boolean, so editing the name — which changes the lines — withdraws the confirmation.
     */
    const [confirmed, setConfirmed] = useState<Record<number, string>>({});

    const running = flow.state.phase === "sealing";

    // Parsed on every keystroke, and deliberately not memoized: `checkGate` compares canonical ids,
    // so a duplicate is caught before anything is spent rather than by the quorum, later, after the
    // money. Five regex matches per keystroke is not worth a dependency array that has to stay right.
    const parsed = drafts.map((values) => kind.parse({ kindId: kind.id, values }));
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
    // What each row asks the user to check by eye, if anything. A seal whose check was skipped is one
    // the ceremony may never open, and it is paid for either way.
    const verifications = parsed.map((entry) =>
        entry.ok && kind.verify !== undefined ? kind.verify(entry.subject) : null,
    );
    const verified = verifications.every(
        (verification, index) => verification === null || confirmed[index] === verification.lines.join("\n"),
    );

    // Derived, not an effect: the ceremony finishing is what advances the last step, and there is no
    // "sealed" the user clicks. Only a run that started *here* counts — reopening the dialog over an
    // already-sealed vault starts at `gate`, because that run is a replacement.
    const step: Step =
        local === "confirm" && flow.state.phase === "sealed" && flow.state.sealFile !== null
            ? "done"
            : local;

    function chooseMethod(id: string): void {
        // A different method has different presets and different fields, so nothing typed for the
        // last one carries over — an address typed as a guardian is not an identity to seal.
        const next = methods.require(id);
        const nextPreset = recommendedPreset(next);
        setOfferId(id);
        setPreset(nextPreset);
        setDrafts(draftsFor(next.kinds[0]!.id, nextPreset.subjectCount));
        setConfirmed({});
    }

    function choosePreset(next: GatePreset): void {
        setPreset(next);
        // Grow or shrink around what is typed: position is the Shamir index, so rebuilding the array
        // would silently renumber guardians.
        setDrafts((prev) => draftsFor(kind.id, next.subjectCount, prev));
    }

    function start(): void {
        if (replacing === null) void flow.seal(method.id, subjects, preset.threshold, timelock);
        else void flow.reseal(method.id, subjects, preset.threshold, timelock);
    }

    const vault = flow.active;
    const save = () => {
        if (vault !== null && flow.state.sealFile !== null) {
            downloadSeal(vault, flow.state.sealFile);
            setDownloaded(true);
        }
    };

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
                    Buys new seals. The current gate stays active until this finishes.
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
                                onClick={() => chooseMethod(offer.id)}
                            >
                                <span className="gate-option__title">{offer.label}</span>
                                <span className="gate-option__cost">{offer.blurb}</span>
                                {offer.unavailable !== undefined && (
                                    <span className="gate-option__blocked">{offer.unavailable}</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {step === "gate" && (
                <div className="stack">
                    {method.presets.length > 1 && (
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
                            </button>
                        ))}
                    </div>
                    )}

                    <div className="field">
                        <span className="field__label">Timelock</span>
                        <div className="gate-picker gate-picker--row">
                            {TIMELOCK_CHOICES.map((choice) => (
                                <button
                                    key={choice.seconds}
                                    type="button"
                                    className={
                                        choice.seconds === timelock
                                            ? "gate-option gate-option--active"
                                            : "gate-option"
                                    }
                                    aria-pressed={choice.seconds === timelock}
                                    aria-label={choice.label}
                                    onClick={() => setTimelock(choice.seconds)}
                                >
                                    <span className="gate-option__title">{choice.short}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {step === "guardians" && (
                <div className="stack">
                    {drafts.map((draft, index) => {
                        const rowLabel =
                            preset.subjectCount === 1
                                ? kind.label
                                : `${capitalize(kind.noun.one)} ${index + 1} of ${preset.subjectCount}`;
                        const single = kind.fields.length === 1;
                        return (
                            <div className="field" key={index}>
                                {!single && <span className="field__label">{rowLabel}</span>}
                                {kind.fields.map((field) => (
                                    <Fragment key={field.key}>
                                        {/* The verdict sits outside this label on purpose: it
                                            carries a "check again" button, and a control inside a
                                            <label> also activates the field the label names. */}
                                        <label className="field__labelled">
                                            <span className="field__label">
                                                {single ? rowLabel : field.label}
                                            </span>
                                            <TextInput
                                                type={inputType(field)}
                                                value={draft[field.key] ?? ""}
                                                ariaLabel={`${single ? kind.noun.one : field.label} ${index + 1}`}
                                                placeholder={field.placeholder ?? ""}
                                                onChange={(event) =>
                                                    setDrafts((prev) =>
                                                        prev.map((entry, i) =>
                                                            i === index
                                                                ? { ...entry, [field.key]: event.target.value }
                                                                : entry,
                                                        ),
                                                    )
                                                }
                                            />
                                        </label>
                                        {field.kind === "email" && (
                                            <DomainVerdict
                                                verdict={domains.verdicts[index]}
                                                onRecheck={() => domains.recheck(index)}
                                            />
                                        )}
                                    </Fragment>
                                ))}
                                {verifications[index] != null && (
                                    <DocumentCheck
                                        verification={verifications[index]}
                                        checked={confirmed[index] === verifications[index].lines.join("\n")}
                                        onChange={(checked) =>
                                            setConfirmed((prev) => ({
                                                ...prev,
                                                [index]: checked ? verifications[index]!.lines.join("\n") : "",
                                            }))
                                        }
                                    />
                                )}
                            </div>
                        );
                    })}

                    {[...fieldIssues, ...issues].map((issue, i) => (
                        <StatusMessage key={i} tone="error">
                            {issue.message}
                        </StatusMessage>
                    ))}

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
                    {/* What the file this buys will say about its holder, before it is bought. */}
                    {method.sealRecords !== undefined && (
                        <Notice tone="caution">{method.sealRecords}</Notice>
                    )}
                    <p>Timelock: {timelockLabel(timelock)}.</p>

                    {flow.state.logs.seal.length > 0 && (
                        <Transcript
                            lines={flow.state.logs.seal}
                            running={flow.state.phase === "sealing"}
                            label="Sealing"
                        />
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

                    {/* Said here, at the moment it becomes true, rather than left for the card
                        behind this dialog. A replaced gate that never reaches the chain is a gate
                        the module does not honour — and the one it still honours is the old one. */}
                    {replacing !== null && (
                        <Notice tone="caution">
                            The chains still use the <strong>old</strong> guardians. Close this and
                            press Protect all chains.
                        </Notice>
                    )}
                    <div className="row">
                        <span className="field__label">Record id</span>
                        <AddressChip value={vault.recordId} display={displayRecordId(vault)} />
                    </div>
                    <Transcript
                        lines={flow.state.logs.seal}
                        running={flow.state.phase === "sealing"}
                        label="Sealing"
                    />
                </div>
            )}
        </Dialog>
    );

    function footerFor(): React.ReactNode {
        if (step === "method") {
            return (
                <DialogActions>
                    {/* "How many" only when there is a choice of how many. A method with one gate — the
                        self guardian — goes straight to the timelock. */}
                    <Button onClick={() => setStep("gate")}>
                        {method.presets.length > 1 ? "How many?" : "Timelock"}
                    </Button>
                </DialogActions>
            );
        }
        if (step === "gate") {
            return (
                <DialogActions back={{ label: "Back", onClick: () => setStep("method") }}>
                    <Button onClick={() => setStep("guardians")}>
                        {method.presets.length === 1
                            ? "Your details"
                            : `Name ${preset.subjectCount} ${preset.subjectCount === 1 ? kind.noun.one : kind.noun.many}`}
                    </Button>
                </DialogActions>
            );
        }
        if (step === "guardians") {
            return (
                <DialogActions back={{ label: "Back", onClick: () => setStep("gate") }}>
                    <Button
                        onClick={() => setStep("confirm")}
                        disabled={!named || domains.blocking || !verified}
                    >
                        {domains.blocking
                            ? "Waiting on the domain check"
                            : named && !verified
                              ? "Confirm the passport lines"
                              : "Review"}
                    </Button>
                </DialogActions>
            );
        }
        if (step === "confirm") {
            return (
                <DialogActions
                    back={{ label: "Back", onClick: () => setStep("guardians"), disabled: running }}
                >
                    <Button onClick={start} disabled={running || !named || !verified}>
                        {running
                            ? `Sealing ${preset.subjectCount} ${preset.subjectCount === 1 ? kind.noun.one : kind.noun.many}…`
                            : `Seal behind ${preset.label.toLowerCase()}`}
                    </Button>
                </DialogActions>
            );
        }
        return (
            // One download action. Before it is pressed, it is the primary; after, "Done" is, and the
            // download stays available once more in case the first one went nowhere.
            <DialogActions>
                <Button variant="ghost" onClick={downloaded ? save : onClose}>
                    {downloaded ? "Download again" : "Close"}
                </Button>
                {downloaded ? (
                    <Button onClick={onClose}>Done</Button>
                ) : (
                    <Button onClick={save} disabled={flow.state.sealFile === null}>
                        Download the seal file
                    </Button>
                )}
            </DialogActions>
        );
    }
}

/**
 * Lines to compare against a physical document, and the box that says the user did.
 *
 * Rendered under the row it belongs to, before anything is paid: it is the only check a person can
 * make that the ceremony cannot, and the cost of skipping it is a vault nobody can open.
 */
function DocumentCheck({
    verification,
    checked,
    onChange,
}: {
    verification: SubjectVerification;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <div className="document-check">
            <span className="field__label">{verification.title}</span>
            <ul className="document-check__lines mono">
                {verification.lines.map((line) => (
                    <li key={line}>{line}</li>
                ))}
            </ul>
            <Notice tone="caution">{verification.warning}</Notice>
            <Checkbox
                label={verification.confirm}
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
            />
        </div>
    );
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
