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
import {
    buildQuorumAppendAdapter,
    buildQuorumCondition,
    buildQuorumProof,
    toStoredSubjects,
} from "./quorum.js";
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
 * The gates offered. The label is the whole of what the picker shows: "2 of 3 to recover" is the
 * status, and what losing a guardian costs is something the reader can work out from it.
 */
const PRESETS = [
    {
        threshold: 1,
        subjectCount: 1,
        label: "1 address",
    },
    {
        threshold: 2,
        subjectCount: 3,
        label: "2 of 3 to recover",
        recommended: true,
    },
    {
        threshold: 3,
        subjectCount: 5,
        label: "3 of 5 to recover",
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
        blurb: "Guardians recover by proving control of their inbox.",
        limits: [
            "Covers loss, not theft: it restores access to an owner who lost it, and does not defend " +
                "a wallet whose seed someone else already holds.",
            "Guardians must be different people.",
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
            // A price before the button that spends it: the count and the unit, nothing else. Which
            // step contacts people is a property of the method, recorded in the two flags above.
            describe: ({ subjectCount }) =>
                options.paid
                    ? `Paid: ${subjectCount} ${subjectCount === 1 ? "seal" : "seals"}, one per guardian.`
                    : `Simulated: ${subjectCount} ceremonies, free.`,
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
                    message: `${threshold} of ${n} is impossible. Lower the threshold to ${n} or fewer.`,
                });
            }
            // The SDK refuses this too, and for the reason worth repeating: with k = 1 every member's
            // share *is* the secret, so the quorum would be a fiction resting on the weakest inbox.
            if (threshold === 1 && n > 1) {
                issues.push({
                    message: `1 of ${n} lets any single guardian recover alone. Raise the threshold.`,
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
            return {
                headline: `any ${gate.threshold} of ${gate.subjectCount} email addresses`,
                slots: gate.subjects.map((subject) => ({
                    index: subject.index,
                    label: subject.label,
                    publicLabel: subject.publicLabel,
                })),
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
                    slots: vault.members.map((member) => ({
                        index: member.index,
                        // A seal records each member's domain-only summary, never the address, so
                        // this is the most a file can say about who its guardians are.
                        label: member.summary,
                        publicLabel: member.summary,
                    })),
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

        appendAdapter(gate: GateRecord) {
            // No ceremony, no network, no payment — see `buildQuorumAppendAdapter`.
            return buildQuorumAppendAdapter(plumbing, gate.subjects);
        },

        async createRecovery(params: MethodRecoveryParams): Promise<MethodRecovery> {
            if (params.gate.mode !== options.mode) {
                // The ceremony that sealed a vault is the only one that can open it.
                throw new Error(
                    `Vault sealed in ${params.gate.mode} mode; this app is in ${options.mode} mode. ` +
                        `Run the app in ${params.gate.mode} mode to recover it.`,
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
