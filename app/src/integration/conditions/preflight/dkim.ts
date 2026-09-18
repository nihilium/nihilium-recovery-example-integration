/**
 * "Can this address actually be proven?", asked against the real registry while the user is still
 * typing it.
 *
 * zkEmail proves an address by checking its DKIM signature against a registry of domain keys. A
 * domain the registry has never seen cannot be proven — so a share sealed against it is a share
 * nobody can ever open, and that failure would otherwise surface *minutes into a recovery*, when
 * nothing can be done about it. Setup is the only moment this check can help, which is why it runs
 * there and nowhere else.
 *
 * **This is a real network call, in both modes.** Whether a domain is provable is a fact about the
 * registry, not about whether this run's ceremony is simulated — so a simulated seal against
 * `posteo.de` is still teaching the user something false unless the check runs. The request carries
 * the domain only: `checkEmailDomain` drops the local part before sending.
 *
 * **To replace:** `serviceUrl`, and the remedy copy if your deployment registers domains differently.
 * **Assumes:** a registry outage is not evidence about a domain — it warns and lets sealing proceed,
 * because blocking on a transient failure trains people to ignore the block.
 */
import { checkEmailDomain, domainOf, domainVerdict, type FetchLike } from "@nihilium/recovery-resolver-dkim";
import type { PreflightVerdict, Subject } from "../types.js";

export interface DkimPreflightOptions {
    /** The zkEmail service, e.g. `https://zkemail.nihilium.io`. */
    serviceUrl: string;
    /** Where a user asks for a domain to be registered. */
    registerEmail?: string;
    /** A stalled check holds the UI in `checking`, which blocks sealing. Defaults to 8 seconds. */
    timeoutMs?: number;
}

export function createDkimPreflight(options: DkimPreflightOptions) {
    const registerEmail = options.registerEmail ?? "recovery@nihilium.io";
    const timeoutMs = options.timeoutMs ?? 8_000;

    return async function dkimPreflight(
        subject: Subject,
        signal: AbortSignal,
    ): Promise<PreflightVerdict> {
        const domain = domainOf(subject.values["email"] ?? subject.id);

        // `checkEmailDomain` takes no signal of its own, so the cancellation and the timeout are
        // injected through its `fetchFn` seam. Without the timeout a stalled request leaves the
        // field reading "checking" forever — and `checking` blocks sealing, so a hung fetch would
        // silently disable the whole flow.
        const fetchWithDeadline: FetchLike = (url, init) =>
            (globalThis as { fetch: (u: string, i?: unknown) => Promise<{ json(): Promise<unknown> }> }).fetch(
                url,
                { ...(init as object | undefined), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) },
            );

        try {
            const check = await checkEmailDomain(options.serviceUrl, domain, fetchWithDeadline);

            switch (domainVerdict(check)) {
                case "eligible":
                    return {
                        status: "ok",
                        code: "dkim:eligible",
                        message: `${domain} is registered — emails from it can be proven.`,
                    };
                case "unsupported":
                    return {
                        status: "blocking",
                        code: "dkim:unsupported",
                        message: `Emails from ${domain} cannot be proven, so a share sealed against this address could never be opened.`,
                        remedy: "Use an address at a different domain.",
                    };
                case "needs_registration":
                    return {
                        status: "blocking",
                        code: "dkim:needs_registration",
                        message: `${domain} is not registered yet — the service has to observe its current DKIM key first.`,
                        remedy: `Ask for it at ${registerEmail}, then check again.`,
                    };
                default:
                    return {
                        status: "blocking",
                        code: "dkim:unverified",
                        message: `No DKIM key is on record for ${domain}, so a recovery through it would be a guess.`,
                        remedy: `Ask about it at ${registerEmail}, then check again.`,
                    };
            }
        } catch (error) {
            if (signal.aborted) {
                return { status: "unknown", code: "dkim:aborted", message: "Cancelled." };
            }
            return {
                status: "warning",
                code: "dkim:unreachable",
                message: `Could not reach the registry to check ${domain}: ${messageOf(error)}`,
                remedy:
                    "Sealing is still allowed — this is a failed check, not a failed domain. Retry " +
                    "before spending, if you can.",
            };
        }
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
