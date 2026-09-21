/**
 * What a recovery method is — and deliberately what it is not.
 *
 * A method describes a *gate*: what a user names, how many of them are needed, what losing some
 * survives, what it costs, and how a vault's recorded gate reads back later. It does **not** describe
 * who runs the ceremony. That arrives as `SubjectKind.adapterFor`, which is what lets one method file
 * serve both the offline demo and the paid live run through a single code path.
 *
 * **To replace:** nothing, to use this gate. Adding a gate — a passport, a passkey, a mixed quorum —
 * is one file next door plus one line in `registry.ts`; nothing in the runner or the UI branches on
 * a method id, and nothing outside `subjects/` knows what an email is.
 * **Assumes:** the caller persists `GateRecord` itself. A seal records each member's *domain* only,
 * because it is a bearer artifact that must not disclose the guardians — so the ordered subject list
 * this app keeps is the only path back from "the user picked this one" to the share it unlocks.
 */
import type {
    Condition,
    ConditionAdapter,
    ConditionProof,
    ConditionType,
    SealBlob,
} from "@nihilium/recovery-core";
import type { IconName } from "../chains/types.js";

/** Who runs the ceremony. The demo's one seam; bound in `registry.ts`, nowhere else. */
export type CeremonyMode = "simulated" | "live";

// ── Subjects ────────────────────────────────────────────────────────────────

/** One input a user fills for one subject. `kind` is a render hint, nothing more. */
export interface SubjectField {
    key: string;
    label: string;
    kind: "text" | "email" | "date";
    placeholder?: string;
    hint?: string;
    autoComplete?: string;
}

export interface SubjectDraft {
    kindId: string;
    values: Readonly<Record<string, string>>;
}

export interface Subject {
    kindId: string;
    /**
     * The canonical comparable form. Duplicate detection compares **this**, never raw input: the
     * quorum enforces distinct *indices*, not distinct identities, so `Alice@Gmail.com` beside
     * `alice@gmail.com` would pass every check downstream and yield a "2-of-3" with one point of
     * failure and no error anywhere.
     */
    id: string;
    values: Readonly<Record<string, string>>;
    /** What the user sees. May name the identity. */
    label: string;
    /** What may be logged, transcribed or stored. Must not identify anyone: "an address at gmail.com". */
    publicLabel: string;
    /** The identity factor's domain, for `checkSealPlacement`. Absent where the concept does not apply. */
    placementDomain?: string;
}

/** Per-member callbacks, handed to one subject's own adapter. */
export interface SubjectHooks {
    onProgress?(message: string): void;
    onPhase?(phase: SubjectPhase): void;
}

export interface SubjectIssue {
    /** The field it belongs under, or absent for an issue about the set as a whole. */
    field?: string;
    /** Which subject, 1-based, where that is meaningful. */
    index?: number;
    message: string;
}

export type ParsedSubject =
    | { ok: true; subject: Subject }
    | { ok: false; issues: readonly SubjectIssue[] };

export type PreflightStatus = "checking" | "ok" | "warning" | "blocking" | "unknown";

export interface PreflightVerdict {
    status: PreflightStatus;
    message: string;
    /** What to do about it. Present on `blocking` and `warning`. */
    remedy?: string;
    /** Machine-readable, for tests and transcripts: `dkim:needs_registration`. */
    code: string;
}

/**
 * One *category* of subject. A single-kind method has exactly one; a mixed quorum has several and the
 * setup UI renders a kind picker per row. This is where email-ness lives, and the only place it may.
 */
export interface SubjectKind {
    id: string;
    label: string;
    noun: { one: string; many: string };
    icon: IconName;
    conditionType: ConditionType;
    readonly fields: readonly SubjectField[];

    /** Cheap and pure — called on every keystroke. Normalizes as well as validates. */
    parse(draft: SubjectDraft): ParsedSubject;

    /**
     * Setup-time only, and optional.
     *
     * A share sealed against something the ceremony can never prove is a share nobody can ever open,
     * and that failure would otherwise surface minutes into a recovery, when nothing can be done. A
     * `blocking` verdict must stop sealing. Absent entirely where there is nothing to check.
     */
    preflight?(subject: Subject, signal: AbortSignal): Promise<PreflightVerdict>;

    /**
     * Build this subject's member adapter. **The seam.** Supplied by `registry.ts`; a method file
     * never constructs an adapter, never reads a mode, and never imports an adapter package.
     */
    adapterFor(subject: Subject, index: number): ConditionAdapter;

    /**
     * This subject as its adapter's `buildCondition` wants it. Adapter-private by design — the SDK
     * deliberately does not re-export `buildCondition`, because the ceremony's parameters belong to
     * whoever runs it — so translating a `Subject` into them is the kind's job and nobody else's.
     */
    conditionParams(subject: Subject): unknown;

    /**
     * The same for `buildProof`, plus the per-member callbacks.
     *
     * The callbacks go **inside** the member's params rather than as one top-level `onProgress`: the
     * quorum forwards params untouched, so progress arrives already attributed to a slot. The
     * alternative is parsing a `[member #2] ` prefix back off a merged log, which is a parser nobody
     * should have to write.
     */
    proofParams(subject: Subject, hooks: SubjectHooks): unknown;
}

// ── Gates ───────────────────────────────────────────────────────────────────

export interface GatePreset {
    threshold: number;
    subjectCount: number;
    /** "2 of 3 to recover" */
    label: string;
    /** What losing some survives. The number never renders alone. */
    survives: string;
    recommended?: boolean;
}

/** One subject as persisted. Kept by this app, because the seal deliberately does not keep it. */
export interface StoredSubject {
    /**
     * The Shamir index, 1-based. Written rather than derived from array position, so a reordering
     * bug is detectable instead of silent.
     */
    index: number;
    kindId: string;
    id: string;
    values: Readonly<Record<string, string>>;
    label: string;
    publicLabel: string;
    /** The identity factor's domain, for `checkSealPlacement`. Absent where the concept does not apply. */
    placementDomain?: string;
}

export interface GateRecord {
    methodId: string;
    threshold: number;
    subjectCount: number;
    /** From the quorum's descriptor. What an interrupted, already-paid setup resumes against. */
    setId: string;
    /** In Shamir order. */
    subjects: readonly StoredSubject[];
    /** A vault sealed live cannot be recovered simulated, or the reverse. Checked before anything slow. */
    mode: CeremonyMode;
    /** `Condition.summary` verbatim, so a vault still describes itself if its method is gone. */
    summary: string;
}

export interface GateDescription {
    /** "any 2 of 3 email addresses" */
    headline: string;
    survives: string;
    slots: readonly { index: number; label: string; publicLabel: string }[];
    /** "Sealed in simulated mode — no email was ever sent." */
    modeNote: string;
    limits: readonly string[];
}

export interface CeremonyCost {
    unit: "per-subject" | "per-vault";
    paid: boolean;
    contactsHumansAtSetup: boolean;
    contactsHumansAtRecovery: boolean;
    /** Rendered before anything is spent, with n and k substituted. */
    describe(gate: { threshold: number; subjectCount: number }): string;
}

// ── Running a gate ──────────────────────────────────────────────────────────

/** Rendered as a row per slot. `awaiting-human` is its own case: it is the wait members exist for. */
export type SubjectPhase =
    | { kind: "idle" }
    | { kind: "requesting"; message: string }
    | { kind: "awaiting-human"; message: string }
    | { kind: "proving"; message: string }
    | { kind: "done"; message: string }
    | { kind: "failed"; reason: string };

export interface SubjectPrompt {
    index: number;
    title: string;
    detail: string;
    /**
     * Present **only** on a simulation. A live ceremony has no button that makes a human answer
     * their mail, and the absence of this field is what stops the UI rendering one — not a mode
     * check, and not a comment asking a component to remember.
     */
    resolve?: () => void;
    reject?: (reason: string) => void;
}

/** One member's seal, as `onSubjectSealed` reports it. Domain-only summary: safe to log. */
export interface SubjectSealed {
    index: number;
    conditionType: ConditionType;
    summary: string;
    seal: SealBlob;
}

/**
 * What a dead, already-paid setup run left behind. In memory only, deliberately: the root secret it
 * would need to persist is the one every recovery key derives from, and putting that in storage is
 * strictly worse than paying for the members again.
 */
export interface SetupCheckpoint {
    setId: string;
    members: readonly SubjectSealed[];
}

export interface MethodSetupParams {
    subjects: readonly Subject[];
    threshold: number;
    onSubjectSealed?(event: SubjectSealed): void;
    onSubjectProgress?(index: number, message: string): void;
    resumeFrom?: SetupCheckpoint;
}

export interface MethodSetup {
    adapter: ConditionAdapter;
    condition: Condition;
    /** Complete but for `summary`, which `Condition` supplies. Persist it verbatim. */
    gate: Omit<GateRecord, "summary">;
}

export interface MethodRecoveryParams {
    gate: GateRecord;
    /** 1-based Shamir indices. Exactly `gate.threshold` of them, distinct and in range. */
    selected: readonly number[];
    onSubjectProgress?(index: number, message: string): void;
    onSubjectPhase?(index: number, phase: SubjectPhase): void;
    onSubjectPrompt?(prompt: SubjectPrompt): void;
}

export interface MethodRecovery {
    adapter: ConditionAdapter;
    proof: ConditionProof;
    /** Both lists, so a UI can show what will *not* happen as prominently as what will. */
    contacted: readonly number[];
    untouched: readonly number[];
}

export interface RecoveryMethod {
    readonly id: string;
    readonly label: string;
    readonly icon: IconName;
    readonly blurb: string;
    /** Said before every setup. "Covers loss, not theft" lives here, not in a README. */
    readonly limits: readonly string[];
    readonly mode: CeremonyMode;
    readonly conditionType: ConditionType;

    readonly kinds: readonly SubjectKind[];
    readonly presets: readonly GatePreset[];
    readonly cost: CeremonyCost;

    /** Everything the SDK would refuse, plus duplicates — locally, before anything is spent. */
    checkGate(params: { subjects: readonly Subject[]; threshold: number }): readonly SubjectIssue[];

    describeGate(gate: GateRecord): GateDescription;
    /** From an imported seal alone, offline, when there is no `GateRecord` to read. */
    describeSeal(seal: SealBlob): GateDescription | null;

    createSetup(params: MethodSetupParams): Promise<MethodSetup>;
    createRecovery(params: MethodRecoveryParams): Promise<MethodRecovery>;

    /**
     * An adapter for a gate that already exists, built without running anything.
     *
     * This is what makes `addChain()` free. Putting a second chain into a vault needs only the
     * vault's published public component, so the adapter has to exist but its ceremony must not run
     * again — a method that re-sealed here would charge for every chain a user adds, which is the
     * exact asymmetry this repo is meant to demonstrate.
     */
    appendAdapter(gate: GateRecord): ConditionAdapter;
}

/**
 * A method as the picker shows it — *including* the ones this build cannot run.
 *
 * The catalogue and the registry are deliberately different lists. A picker that only shows what is
 * wired teaches that the wired thing is all there is, and the SDK ships condition adapters this demo
 * has not integrated; showing them greyed, with the reason, is the more honest shape and the one a
 * reader can act on. `unavailable` is copy, not a boolean dressed up — it names what is missing.
 */
export interface MethodOffer {
    readonly id: string;
    readonly label: string;
    readonly icon: IconName;
    readonly blurb: string;
    /** True exactly when `MethodRegistry.get(id)` resolves. */
    readonly available: boolean;
    /** Why not. Rendered beside the option, never swallowed into a disabled state. */
    readonly unavailable?: string;
}

export interface MethodRegistry {
    all(): RecoveryMethod[];
    get(id: string): RecoveryMethod | undefined;
    /** Throws: a missing method is a programming error, not a state to render. */
    require(id: string): RecoveryMethod;
    /** Every method the picker offers, wired or not, in the order it should show them. */
    offers(): readonly MethodOffer[];
}
