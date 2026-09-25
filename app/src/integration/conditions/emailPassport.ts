/**
 * The second recovery method: **your own inbox and your own passport**, both, in one ceremony.
 *
 * No quorum. The fused adapter already requires both factors and binds them to each other — one
 * preimage, one `tied_hash`, which is both the recovery email's subject and the passport proof's
 * `custom_data` — so neither proof can be replayed into another recovery. Wrapping it in a 1-of-1
 * quorum would add a Shamir layer over a single share and change nothing but the seal's size, so this
 * file calls the adapter directly, which is how its README shows it and what `quorum.ts`'s header
 * says a single indivisible identity should do.
 *
 * **To replace:** the copy. A product offering this beside guardians would label it as the owner's
 * own route in, which is what it is.
 * **Assumes:** exactly one subject, and a kind whose adapter records the identity on the seal — so
 * recovery needs the seal and nothing typed. `appendAdapter` relies on `sealRecord` being local
 * encryption to the vault's public key, which it is for every Nihilium adapter.
 */
import type { SealBlob, SealPublicComponent } from "@nihilium/recovery-core";
import { asSubject, toStoredSubjects } from "./quorum.js";
import type {
    CeremonyMode,
    GateDescription,
    GateRecord,
    MethodRecovery,
    MethodRecoveryParams,
    MethodSetup,
    MethodSetupParams,
    RecoveryMethod,
    SubjectIssue,
    SubjectKind,
} from "./types.js";

export const EMAIL_ZKPASSPORT_METHOD_ID = "email-zkpassport";

/** Shared with `registry.ts`, which shows the same offer greyed out when it cannot be built. */
export const EMAIL_PASSPORT_LABEL = "Self guardian: email and passport";
export const EMAIL_PASSPORT_BLURB = "You guard your own vault: your inbox and your passport, both required.";

/** The one slot. Its index is fixed so a stored gate reads the same way a quorum's does. */
const ONLY = 1;

export interface EmailPassportOptions {
    kind: SubjectKind;
    mode: CeremonyMode;
    paid: boolean;
    /** The adapter's `publicComponentOf`, for describing a seal with no gate record beside it. */
    readSeal?(seal: SealBlob): SealPublicComponent;
}

export function createEmailPassportMethod(options: EmailPassportOptions): RecoveryMethod {
    const { kind } = options;

    return {
        id: EMAIL_ZKPASSPORT_METHOD_ID,
        label: EMAIL_PASSPORT_LABEL,
        icon: "ShieldCheck",
        blurb: EMAIL_PASSPORT_BLURB,
        limits: [
            "Covers loss, not theft: it restores access to an owner who lost it, and does not defend " +
                "a wallet whose seed someone else already holds.",
            "A recovery opens the whole vault, so every chain it protects is exposed to whoever ran it.",
        ],
        // The adapter's own choice, stated where it is paid for: a recovery needs no re-entered
        // fields because the seal carries them — and a date of birth cannot be rotated.
        sealRecords: "The seal file records your email address, name and date of birth.",
        mode: options.mode,
        conditionType: kind.conditionType,
        kinds: [kind],
        presets: [{ threshold: 1, subjectCount: 1, label: "Your email and passport", recommended: true }],

        cost: {
            unit: "per-vault",
            paid: options.paid,
            contactsHumansAtSetup: false,
            contactsHumansAtRecovery: true,
            // One ceremony whatever the processor threshold: both factors share one seal.
            describe: () => (options.paid ? "Paid: 1 seal." : "Simulated: 1 ceremony, free."),
        },

        checkGate({ subjects, threshold }): readonly SubjectIssue[] {
            if (subjects.length !== 1 || threshold !== 1) {
                return [{ message: "This method seals exactly one identity: yours." }];
            }
            return [];
        },

        describeGate(gate: GateRecord): GateDescription {
            return {
                headline: "your email and passport",
                slots: gate.subjects.map((subject) => ({
                    index: subject.index,
                    label: subject.label,
                    publicLabel: subject.publicLabel,
                })),
            };
        },

        describeSeal(seal: SealBlob): GateDescription | null {
            if (options.readSeal === undefined) return null;
            try {
                const component = options.readSeal(seal);
                if (component.conditionType !== kind.conditionType) return null;
                return {
                    headline: "an email and a passport",
                    slots: [
                        {
                            index: ONLY,
                            label: component.conditionSummary,
                            publicLabel: component.conditionSummary,
                        },
                    ],
                };
            } catch {
                return null;
            }
        },

        async createSetup(params: MethodSetupParams): Promise<MethodSetup> {
            const issues = this.checkGate({ subjects: params.subjects, threshold: params.threshold });
            if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));

            const subject = params.subjects[0]!;
            const adapter = kind.adapterFor(subject, ONLY);
            // Both factors are validated here, before anything is paid for: the SDK refuses a bad
            // address and an unusable date of birth at build time, not at recovery.
            const condition = await adapter.buildCondition(kind.conditionParams(subject));

            return {
                adapter,
                condition,
                gate: {
                    methodId: EMAIL_ZKPASSPORT_METHOD_ID,
                    threshold: 1,
                    subjectCount: 1,
                    setId: crypto.randomUUID(),
                    subjects: toStoredSubjects(params.subjects),
                    mode: options.mode,
                },
            };
        },

        appendAdapter(gate: GateRecord) {
            // The same adapter, no ceremony: `sealRecord` encrypts to the public key the seal
            // already published. Adding a chain costs nothing, which is the point.
            return kind.adapterFor(asSubject(gate.subjects[0]!), ONLY);
        },

        async createRecovery(params: MethodRecoveryParams): Promise<MethodRecovery> {
            if (params.gate.mode !== options.mode) {
                throw new Error(
                    `Vault sealed in ${params.gate.mode} mode; this app is in ${options.mode} mode. ` +
                        `Run the app in ${params.gate.mode} mode to recover it.`,
                );
            }
            const stored = params.gate.subjects[0];
            if (stored === undefined) throw new Error("This vault records no identity to recover with.");

            const subject = asSubject(stored);
            const adapter = kind.adapterFor(subject, ONLY);
            params.onSubjectPhase?.(ONLY, { kind: "requesting", message: "starting the ceremony" });
            const proof = await adapter.buildProof(
                kind.proofParams(subject, {
                    onProgress: (message) => params.onSubjectProgress?.(ONLY, message),
                    onPhase: (phase) => params.onSubjectPhase?.(ONLY, phase),
                    onPrompt: (prompt) =>
                        params.onSubjectPrompt?.(ONLY, prompt === null ? null : { ...prompt, index: ONLY }),
                }),
            );

            return { adapter, proof, contacted: [ONLY], untouched: [] };
        },
    };
}
