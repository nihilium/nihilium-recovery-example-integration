/**
 * What a recovery method is — and deliberately what it is not.
 *
 * The SDK's `GateDriver` is what the orchestration needs from a gate: seal, open with a proof, append
 * a chain without running anything. A `RecoveryMethod` is that plus what a *picker* needs: presets,
 * copy, costs, and the subject kinds a user fills in. The render-shaped half lives here; the SDK
 * never sees it.
 *
 * **To replace:** nothing, to use this gate. Adding a gate — a passport, a passkey, a mixed quorum —
 * is one file next door plus one line in `registry.ts`; nothing in the runner or the UI branches on
 * a method id, and nothing outside `subjects/` knows what an email is.
 * **Assumes:** the caller persists `GateRecord` itself, as the SDK's ledger does.
 */
import type { ConditionType, SealBlob } from "@nihilium/recovery-core";
import type {
    GateDescription,
    GateDriver,
    GateMember,
    GateRecord,
    GateSubject,
    PreflightVerdict,
    SubjectHooks,
} from "@nihilium/recovery-sdk/gates";
import type { IconName } from "../chains/types.js";

export type {
    GateDescription,
    GateRecord,
    GateRecovery as MethodRecovery,
    GateRecoveryParams as MethodRecoveryParams,
    GateSetup as MethodSetup,
    GateSetupParams as MethodSetupParams,
    MemberPrompt,
    PreflightStatus,
    PreflightVerdict,
    SetupCheckpoint,
    StoredSubject,
    SubjectHooks,
    SubjectPhase,
    SubjectPrompt,
    SubjectSealed,
} from "@nihilium/recovery-sdk/gates";

/** Who runs the ceremony. The demo's one seam; bound in `registry.ts`, nowhere else. */
export type CeremonyMode = "simulated" | "live";

/** A subject as the SDK's gates see it. The canonical `id` is what duplicate detection compares. */
export type Subject = GateSubject;

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

export interface SubjectIssue {
    field?: string;
    /** Which subject, 1-based, where that is meaningful. */
    index?: number;
    message: string;
}

export type ParsedSubject = { ok: true; subject: Subject } | { ok: false; issues: readonly SubjectIssue[] };

/** Lines to compare against a document, what a difference costs, and what the user confirms. */
export interface SubjectVerification {
    title: string;
    lines: readonly string[];
    warning: string;
    confirm: string;
}

/**
 * One *category* of subject: the SDK's `GateMember` — how to build the adapter and phrase the params —
 * plus what the setup UI renders. This is where email-ness lives, and the only place it may.
 */
export interface SubjectKind extends GateMember {
    id: string;
    label: string;
    noun: { one: string; many: string };
    icon: IconName;
    conditionType: ConditionType;
    readonly fields: readonly SubjectField[];
    /** Cheap and pure — called on every keystroke. Normalizes as well as validates. */
    parse(draft: SubjectDraft): ParsedSubject;
    /** Setup-time only. A `blocking` verdict must stop sealing. Absent where there is nothing to check. */
    preflight?(subject: Subject, signal: AbortSignal): Promise<PreflightVerdict>;
    /** What happens to this subject when a recovery selects it — "will be emailed". */
    readonly contact: string;
    /** Something the user must check against a physical document before paying. */
    verify?(subject: Subject): SubjectVerification | null;
    proofParams(subject: Subject, hooks: SubjectHooks): unknown;
}

// ── Gates ───────────────────────────────────────────────────────────────────

export interface GatePreset {
    threshold: number;
    subjectCount: number;
    /** "2 of 3 to recover" */
    label: string;
    recommended?: boolean;
}

export interface CeremonyCost {
    unit: "per-subject" | "per-vault";
    paid: boolean;
    contactsHumansAtSetup: boolean;
    contactsHumansAtRecovery: boolean;
    /** Rendered before anything is spent, with n and k substituted. */
    describe(gate: { threshold: number; subjectCount: number }): string;
}

export interface RecoveryMethod extends GateDriver {
    readonly label: string;
    readonly icon: IconName;
    readonly blurb: string;
    /** Said before every setup. "Covers loss, not theft" lives here, not in a README. */
    readonly limits: readonly string[];
    /** What the seal file discloses about the person it protects, when that is more than a domain. */
    readonly sealRecords?: string;
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
}

/** A method as the picker shows it — *including* the ones this build cannot run. */
export interface MethodOffer {
    readonly id: string;
    readonly label: string;
    readonly icon: IconName;
    readonly blurb: string;
    readonly available: boolean;
    /** Why not. Rendered beside the option, never swallowed into a disabled state. */
    readonly unavailable?: string;
}

export interface MethodRegistry {
    all(): RecoveryMethod[];
    get(id: string): RecoveryMethod | undefined;
    /** Throws: a missing method is a programming error, not a state to render. */
    require(id: string): RecoveryMethod;
    offers(): readonly MethodOffer[];
}
