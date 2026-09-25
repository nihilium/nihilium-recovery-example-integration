/**
 * The email-and-passport subject kind: one person, proving an inbox **and** a passport.
 *
 * The fields are what the fused adapter commits to — an address, and a passport's given name,
 * surname and exact date of birth. Recovery needs both halves at once: the adapter sends the
 * recovery email and, in the same turn, asks for a passport proof bound to the same value. This file
 * answers that ask by running `PassportProver` and surfacing its link as a prompt, with a retry,
 * because a scan is something a human can decline or let go stale and then try again.
 *
 * **To replace:** `prover`, `adapterFor` and `preflight`, all injected by `registry.ts`.
 * **Assumes:** the adapter records this identity on the seal — `@nihilium/recovery-condition-zkemail-
 * zkpassport` does, deliberately, so a recovery needs no re-entered fields. A seal is a bearer file
 * that gets backed up in many places, and a date of birth cannot be rotated; the method says so
 * before anything is paid.
 */
import { iso, normalizeBirthdate } from "@nihilium/recovery-condition-zkpassport";
import type { PassportVerifierParameters } from "@nihilium/recovery-condition-zkpassport";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import { mrzNameCandidates } from "../passport/mrz.js";
import type {
    PassportProver,
    PassportRequest,
    PassportScanStatus,
} from "../passport/zkPassportProver.js";
import type {
    ParsedSubject,
    PreflightVerdict,
    Subject,
    SubjectDraft,
    SubjectHooks,
    SubjectIssue,
    SubjectKind,
    SubjectPhase,
} from "../types.js";

export const EMAIL_PASSPORT_KIND_ID = "email+passport";

export interface EmailPassportSubjectKindOptions {
    adapterFor(subject: Subject, index: number): ConditionAdapter;
    preflight?(subject: Subject, signal: AbortSignal): Promise<PreflightVerdict>;
    /** Produces the passport proof the adapter asks for. The ZKPassport SDK, in the live app. */
    prover: PassportProver;
}

export function createEmailPassportSubjectKind(options: EmailPassportSubjectKindOptions): SubjectKind {
    return {
        id: EMAIL_PASSPORT_KIND_ID,
        label: "Your email and passport",
        noun: { one: "identity", many: "identities" },
        icon: "ShieldCheck",
        conditionType: "zkemail+zkpassport",
        contact: "will be emailed and asked to scan a passport",
        fields: [
            {
                key: "email",
                label: "Email address",
                kind: "email",
                placeholder: "you@example.com",
                autoComplete: "email",
            },
            {
                key: "firstname",
                label: "Given names, as in the passport",
                kind: "text",
                autoComplete: "given-name",
            },
            {
                key: "lastname",
                label: "Surname, as in the passport",
                kind: "text",
                autoComplete: "family-name",
            },
            {
                key: "birthdate",
                label: "Date of birth",
                kind: "date",
                placeholder: "YYYY-MM-DD",
                autoComplete: "bday",
            },
        ],

        parse(draft: SubjectDraft): ParsedSubject {
            const issues: SubjectIssue[] = [];
            const email = (draft.values["email"] ?? "").trim();
            const at = email.indexOf("@");
            if (email === "") issues.push({ field: "email", message: "Enter an email address." });
            else if (at <= 0 || at === email.length - 1 || email.includes(" ")) {
                issues.push({ field: "email", message: `"${email}" is not an email address.` });
            }

            // Both names, always. With either missing the adapter's commitment silently leaves the
            // name out, and the passport proof — which discloses the whole MRZ name — never matches.
            const firstname = collapse(draft.values["firstname"]);
            const lastname = collapse(draft.values["lastname"]);
            if (firstname === "") issues.push({ field: "firstname", message: "Enter the given names." });
            if (lastname === "") issues.push({ field: "lastname", message: "Enter the surname." });

            let birthdate = "";
            const rawDate = (draft.values["birthdate"] ?? "").trim();
            if (rawDate === "") {
                issues.push({ field: "birthdate", message: "Enter the date of birth." });
            } else {
                // The SDK's own check, not a copy: it refuses the dates ZKPassport reads as "no
                // bound" (1900-01-01, 1970-01-01), which would seal a gate any passport opens.
                try {
                    birthdate = iso(normalizeBirthdate(rawDate));
                } catch (error) {
                    issues.push({
                        field: "birthdate",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            if (issues.length > 0) return { ok: false, issues };

            const id = email.toLowerCase();
            const domain = id.slice(id.indexOf("@") + 1);
            return {
                ok: true,
                subject: {
                    kindId: EMAIL_PASSPORT_KIND_ID,
                    id,
                    values: { email: id, firstname, lastname, birthdate },
                    label: `${id} · ${firstname} ${lastname}, born ${birthdate}`,
                    // Never the name or the date: this is the form that gets logged and transcribed.
                    publicLabel: `an address at ${domain} and a passport`,
                    placementDomain: domain,
                },
            };
        },

        ...(options.preflight === undefined ? {} : { preflight: options.preflight }),

        // The one check nothing downstream can make: whether the name typed is the name the passport
        // carries in its machine-readable zone. A difference is a vault no passport opens.
        verify(subject) {
            const lines = mrzNameCandidates(subject.values["firstname"] ?? "", subject.values["lastname"] ?? "");
            if (lines.length === 0) return null;
            return {
                title: "Check against your passport",
                lines: lines.map((line) => line.compared),
                warning:
                    "The first of the two lines at the bottom of your passport's photo page, after " +
                    "P< and the country code, must start with one of these exactly. If it does " +
                    "not, this vault can never be recovered. ID cards cannot be used.",
                confirm: "My passport's line starts with one of these",
            };
        },

        adapterFor: options.adapterFor,

        conditionParams: (subject) => ({
            email: subject.values["email"],
            firstname: subject.values["firstname"],
            lastname: subject.values["lastname"],
            birthdate: subject.values["birthdate"],
        }),

        proofParams: (subject, hooks: SubjectHooks) => ({
            email: subject.values["email"],
            onProgress: (message: string) => hooks.onProgress?.(message),
            onPhase: (phase: string) => hooks.onPhase?.(toSubjectPhase(phase)),
            onPassportRequest: (
                request: PassportRequest,
                submit: (proof: PassportVerifierParameters) => Promise<void>,
            ) => runScan(options.prover, request, submit, hooks),
        }),
    };
}

const SCAN_TITLE = "Scan your passport";
const SCAN_LINK_LABEL = "Open in ZKPassport";

const STATUS_DETAIL: Record<PassportScanStatus, string> = {
    starting: "building the request",
    waiting: "waiting for a scan",
    scanned: "request opened on the phone",
    generating: "proof being generated on the phone",
    verifying: "checking the proof",
};

/**
 * Drives the passport half until a proof is accepted.
 *
 * `submit` rejecting is not the end of a recovery: the adapter keeps waiting for a proof that
 * matches, so a mismatch — the wrong passport, a name spelled differently — leaves the prompt up with
 * the reason and a retry. A retry supersedes the attempt in flight rather than racing it.
 */
export function runScan(
    prover: PassportProver,
    request: PassportRequest,
    submit: (proof: PassportVerifierParameters) => Promise<void>,
    hooks: SubjectHooks,
): void {
    let current: AbortController | null = null;
    let link: string | null = null;

    const show = (detail: string, error?: string) =>
        hooks.onPrompt?.({
            title: SCAN_TITLE,
            detail,
            ...(link === null ? {} : { link: { url: link, label: SCAN_LINK_LABEL } }),
            retry,
            ...(error === undefined ? {} : { error }),
        });

    const attempt = async () => {
        current?.abort(new Error("superseded by a new request"));
        const mine = new AbortController();
        current = mine;
        link = null;
        try {
            const proof = await prover.prove(
                request,
                {
                    onLink: (url) => {
                        if (current === mine) link = url;
                    },
                    onStatus: (status) => {
                        if (current === mine) show(STATUS_DETAIL[status]);
                    },
                },
                mine.signal,
            );
            if (current !== mine) return;
            show(STATUS_DETAIL.verifying);
            await submit(proof);
            if (current === mine) hooks.onPrompt?.(null);
        } catch (error) {
            if (current !== mine) return;
            link = null;
            show("no proof yet", error instanceof Error ? error.message : String(error));
        }
    };

    const retry = () => void attempt();
    void attempt();
}

/**
 * `ZKEmailZKPassportPhase` -> `SubjectPhase`.
 *
 * Three of its phases are waits on a human, and which human is the whole of what a row should say:
 * both outstanding, only the reply, or only the scan.
 */
function toSubjectPhase(phase: string): SubjectPhase {
    switch (phase) {
        case "preparing":
            return { kind: "requesting", message: "publishing reveal values" };
        case "awaiting_email_reply_and_passport_scan":
            return { kind: "awaiting-human", message: "emailed — waiting for a reply and a scan" };
        case "awaiting_email_reply":
            return { kind: "awaiting-human", message: "passport in — waiting for the email reply" };
        case "awaiting_passport_proof":
            return { kind: "awaiting-human", message: "reply in — waiting for the passport scan" };
        case "proving":
            return { kind: "proving", message: "producing the email proof" };
        case "unsealing":
            return { kind: "proving", message: "asking the processors to unseal" };
        case "done":
            return { kind: "done", message: "vault key recovered" };
        default:
            return { kind: "proving", message: phase };
    }
}

function collapse(value: string | undefined): string {
    return (value ?? "").trim().replaceAll(/\s+/g, " ");
}
