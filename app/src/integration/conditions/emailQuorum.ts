/**
 * The first recovery method: **any k of n email addresses**.
 *
 * This file is presets, copy, local refusals and delegation. It constructs no adapter, imports no
 * adapter package, contains no `@` in its logic and never asks which mode it is running in — those
 * belong to `subjects/email.ts` and `registry.ts` respectively. That separation is the whole claim
 * that this is a *mechanism* rather than one gate: a passport method is the same file with different
 * presets and a different kind.
 *
 * **To replace:** the presets and their copy, which are product decisions, not protocol ones.
 * **Assumes:** exactly one subject kind. A mixed quorum would keep `kinds` plural and resolve per
 * subject — `quorum.ts` already does.
 */
import { parseQuorumVault } from "@nihilium/recovery-condition-quorum";
import type { SealBlob } from "@nihilium/recovery-core";
import { buildQuorumCondition, buildQuorumProof, toStoredSubjects } from "./quorum.js";
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

export const EMAIL_QUORUM_METHOD_ID = "email-quorum";

/**
 * What each gate survives, which is how a k-of-n is explained to someone who does not want a lecture
 * on secret sharing. The number never renders without this line beside it.
 */
const PRESETS = [
    {
        threshold: 1,
        subjectCount: 1,
        label: "1 address",
        survives: "Survives nothing — that single inbox is the whole gate.",
    },
    {
        threshold: 2,
        subjectCount: 3,
        label: "2 of 3 to recover",
        survives: "Survives losing 1 of them.",
        recommended: true,
    },
    {
        threshold: 3,
        subjectCount: 5,
        label: "3 of 5 to recover",
        survives: "Survives losing 2 of them.",
    },
] as const;

export interface EmailQuorumOptions {
    kind: SubjectKind;
    mode: CeremonyMode;
    /** Live sealing is billed per member; the simulated cohort is free. Drives the cost copy. */
    paid: boolean;
}

export function createEmailQuorumMethod(options: EmailQuorumOptions): RecoveryMethod {
    const kindFor = () => options.kind;
    const plumbing = { kindFor };

    return {
        id: EMAIL_QUORUM_METHOD_ID,
        label: "Email guardians",
        icon: "UserGroup",
        blurb:
            "Name a few email addresses. Recovery needs any k of them to prove control of their " +
            "inbox — nobody needs to hold a key, and no one of them can act alone.",
        limits: [
            "Covers loss, not theft: it restores access to an owner who lost it, and does not defend " +
                "a wallet whose seed someone else already holds.",
            "Guardians must be different people, or the redundancy is decoration.",
            "A recovery opens the whole vault, so every chain it protects is exposed to whoever ran it.",
        ],
        mode: options.mode,
        conditionType: "quorum",
        kinds: [options.kind],
        presets: [...PRESETS],

        cost: {
            unit: "per-subject",
            paid: options.paid,
            contactsHumansAtSetup: false,
            contactsHumansAtRecovery: true,
            describe: ({ threshold, subjectCount }) =>
                options.paid
                    ? `Sealing is paid, once per guardian — ${subjectCount} ` +
                      `${subjectCount === 1 ? "seal" : "seals"} for this choice. It sends no email: the ` +
                      `human round trip happens only at recovery, and only for the ${threshold} you ` +
                      "name then."
                    : `Simulated: ${subjectCount} ceremonies, free and instant, and no email is ever ` +
                      `sent. A live run would bill one seal per guardian and, at recovery, wait on ` +
                      `${threshold} humans.`,
        },

        checkGate({ subjects, threshold }): readonly SubjectIssue[] {
            const issues: SubjectIssue[] = [];
            const n = subjects.length;

            if (n === 0) return [{ message: "Name at least one guardian." }];
            if (!Number.isInteger(threshold) || threshold < 1) {
                issues.push({ message: "The threshold must be a whole number of at least 1." });
            }
            if (threshold > n) {
                issues.push({
                    message: `${threshold} of ${n} could never be satisfied — there are only ${n}.`,
                });
            }
            // The SDK refuses this too, and for the reason worth repeating: with k = 1 every member's
            // share *is* the secret, so the quorum would be a fiction resting on the weakest inbox.
            if (threshold === 1 && n > 1) {
                issues.push({
                    message:
                        `A 1-of-${n} is weaker than any single guardian, since it can be recovered ` +
                        "through whichever one is easiest to compromise. Raise the threshold, or name " +
                        "one guardian and mean it.",
                });
            }

            // Canonical ids, never raw input: the quorum enforces distinct indices, not distinct
            // people, so three copies of one address would pass everything downstream.
            const seen = new Map<string, number>();
            subjects.forEach((subject, position) => {
                const first = seen.get(subject.id);
                if (first !== undefined) {
                    issues.push({
                        index: position + 1,
                        field: "email",
                        message:
                            `${subject.label} is already guardian ${first}. A ${threshold}-of-${n} with ` +
                            "a repeat has fewer real guardians than it claims.",
                    });
                    return;
                }
                seen.set(subject.id, position + 1);
            });

            return issues;
        },

        describeGate(gate: GateRecord): GateDescription {
            const preset = PRESETS.find(
                (candidate) =>
                    candidate.threshold === gate.threshold &&
                    candidate.subjectCount === gate.subjectCount,
            );
            return {
                headline: `any ${gate.threshold} of ${gate.subjectCount} email addresses`,
                survives:
                    preset?.survives ??
                    `Survives losing ${gate.subjectCount - gate.threshold} of them.`,
                slots: gate.subjects.map((subject) => ({
                    index: subject.index,
                    label: subject.label,
                    publicLabel: subject.publicLabel,
                })),
                modeNote:
                    gate.mode === "simulated"
                        ? "Sealed in simulated mode — no ceremony was bought and no email was ever sent."
                        : "Sealed against the live ceremony — each guardian's seal was paid for.",
                limits: [
                    `Fewer than ${gate.threshold} cannot recover, and no single guardian can act alone.`,
                    "The seal file names every guardian: whoever holds it learns the whole set.",
                ],
            };
        },

        /**
         * From an imported seal alone, with no ledger and no network — which is the position a user
         * recovering on a new device is actually in.
         */
        describeSeal(seal: SealBlob): GateDescription | null {
            try {
                const vault = parseQuorumVault(seal);
                return {
                    headline: `any ${vault.threshold} of ${vault.members.length} guardians`,
                    survives: `Survives losing ${vault.members.length - vault.threshold} of them.`,
                    slots: vault.members.map((member) => ({
                        index: member.index,
                        // A seal records each member's domain-only summary, never the address, so
                        // this is the most a file can say about who its guardians are.
                        label: member.summary,
                        publicLabel: member.summary,
                    })),
                    modeNote: "Read from the seal file itself — offline, and believing nothing else.",
                    limits: ["The seal does not record which addresses these are, only their domains."],
                };
            } catch {
                return null;
            }
        },

        async createSetup(params: MethodSetupParams): Promise<MethodSetup> {
            const issues = this.checkGate({ subjects: params.subjects, threshold: params.threshold });
            if (issues.length > 0) {
                // Refused here, before a single ceremony is bought. The SDK would refuse too — later,
                // and after the money.
                throw new Error(issues.map((issue) => issue.message).join(" "));
            }

            const built = await buildQuorumCondition(plumbing, {
                subjects: params.subjects,
                threshold: params.threshold,
                ...(params.onSubjectSealed ? { onSubjectSealed: params.onSubjectSealed } : {}),
                ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
            });

            return {
                adapter: built.adapter,
                condition: built.condition,
                gate: {
                    methodId: EMAIL_QUORUM_METHOD_ID,
                    threshold: params.threshold,
                    subjectCount: params.subjects.length,
                    setId: built.setId,
                    subjects: toStoredSubjects(params.subjects),
                    mode: options.mode,
                },
            };
        },

        async createRecovery(params: MethodRecoveryParams): Promise<MethodRecovery> {
            if (params.gate.mode !== options.mode) {
                throw new Error(
                    `This vault was sealed in ${params.gate.mode} mode and this app is running in ` +
                        `${options.mode} mode. The ceremony that sealed it is the only one that can ` +
                        "open it.",
                );
            }
            const selected = [...new Set(params.selected)];
            if (selected.length !== params.gate.threshold) {
                // Said now rather than minutes into a ceremony that could only have ended here:
                // fewer cannot reconstruct, and more drags a guardian through a round trip nobody needs.
                throw new Error(
                    `This vault needs exactly ${params.gate.threshold} of its ${params.gate.subjectCount} ` +
                        `guardians named — ${selected.length} ${selected.length === 1 ? "was" : "were"}.`,
                );
            }

            const built = await buildQuorumProof(plumbing, {
                subjects: params.gate.subjects,
                selected,
                hooksFor: (index) => ({
                    onProgress: (message) => params.onSubjectProgress?.(index, message),
                    onPhase: (phase) => params.onSubjectPhase?.(index, phase),
                }),
                ...(params.onSubjectPhase ? { onPhase: params.onSubjectPhase } : {}),
            });

            return {
                adapter: built.adapter,
                proof: built.proof,
                contacted: built.contacted,
                untouched: built.untouched,
            };
        },
    };
}
