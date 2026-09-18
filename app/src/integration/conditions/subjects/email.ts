/**
 * The email subject kind — the only file in this app that knows what an email address is.
 *
 * Everything above it (`emailQuorum.ts`, the runner, the UI) deals in `Subject`s: a canonical id, a
 * label, a public label and a placement domain. That is what makes a second kind — a passport, a
 * passkey — a file next door rather than a rewrite.
 *
 * **To replace:** `preflight`, if your ceremony can prove addresses this one cannot, and
 * `adapterFor`, which is injected rather than chosen here. **Assumes:** addresses are compared
 * case-insensitively after trimming, which is what makes duplicate detection work — the quorum
 * enforces distinct *indices*, not distinct identities, so `Alice@Gmail.com` beside
 * `alice@gmail.com` would otherwise pass every check and leave a "2-of-3" with one real guardian.
 */
import type {
    ParsedSubject,
    SubjectPhase,
    PreflightVerdict,
    Subject,
    SubjectDraft,
    SubjectHooks,
    SubjectKind,
} from "../types.js";
import type { ConditionAdapter } from "@nihilium/recovery-core";

export const EMAIL_KIND_ID = "email";

export interface EmailSubjectKindOptions {
    /** The seam: `registry.ts` decides whether this is a simulated member or a live zkEmail one. */
    adapterFor(subject: Subject, index: number): ConditionAdapter;
    /** Absent in simulated mode, where every domain is provable because nothing is proved. */
    preflight?(subject: Subject, signal: AbortSignal): Promise<PreflightVerdict>;
}

export function createEmailSubjectKind(options: EmailSubjectKindOptions): SubjectKind {
    return {
        id: EMAIL_KIND_ID,
        label: "Email address",
        noun: { one: "guardian", many: "guardians" },
        icon: "UserGroup",
        conditionType: "zkemail",
        fields: [
            {
                key: "email",
                label: "Email address",
                kind: "email",
                placeholder: "alice@example.com",
                autoComplete: "email",
                hint: "Whoever controls this inbox can take part in a recovery.",
            },
        ],

        parse(draft: SubjectDraft): ParsedSubject {
            const raw = (draft.values["email"] ?? "").trim();
            if (raw === "") {
                return { ok: false, issues: [{ field: "email", message: "Enter an email address." }] };
            }
            // Deliberately not an RFC-5322 validator: the ceremony is the real check, and a regex
            // strict enough to be correct rejects addresses that work.
            const at = raw.indexOf("@");
            if (at <= 0 || at === raw.length - 1 || raw.includes(" ")) {
                return {
                    ok: false,
                    issues: [{ field: "email", message: `"${raw}" is not an email address.` }],
                };
            }
            const id = raw.toLowerCase();
            const domain = id.slice(id.indexOf("@") + 1);
            return {
                ok: true,
                subject: {
                    kindId: EMAIL_KIND_ID,
                    id,
                    values: { email: id },
                    label: raw,
                    // Domain-only, matching what the seal itself records. Safe to log or transcribe.
                    publicLabel: `an address at ${domain}`,
                    placementDomain: domain,
                },
            };
        },

        ...(options.preflight === undefined ? {} : { preflight: options.preflight }),

        adapterFor: options.adapterFor,

        conditionParams: (subject) => ({ email: subject.values["email"] }),

        proofParams: (subject, hooks: SubjectHooks) => ({
            email: subject.values["email"],
            onProgress: (message: string) => hooks.onProgress?.(message),
            // The structured counterpart, mapped onto this app's own phases. `awaiting_email_reply`
            // is the one that matters: it is the multi-minute wait on a human, and a row that read
            // "working…" through it would be hiding the whole character of a recovery.
            onPhase: (phase: string) => hooks.onPhase?.(toSubjectPhase(phase)),
        }),
    };
}

/**
 * `ZKEmailPhase` -> `SubjectPhase`.
 *
 * The live adapter's phases are its own and may grow; anything unrecognised is reported as work in
 * progress rather than dropped, so a new phase upstream degrades to "something is happening" rather
 * than to a row that looks stalled.
 */
function toSubjectPhase(phase: string): SubjectPhase {
    switch (phase) {
        case "preparing":
            return { kind: "requesting", message: "publishing reveal values" };
        case "awaiting_email_reply":
            return { kind: "awaiting-human", message: "emailed — waiting for a reply" };
        case "proving":
            return { kind: "proving", message: "reply received, producing the proof" };
        case "unsealing":
            return { kind: "proving", message: "asking the processors to unseal" };
        case "done":
            return { kind: "done", message: "share recovered" };
        default:
            return { kind: "proving", message: phase };
    }
}
