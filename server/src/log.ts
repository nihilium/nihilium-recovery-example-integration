/**
 * Role-tagged logging, and one thing that matters more than it looks: unwrapping viem's errors.
 *
 * viem nests the part that identifies a failure — the decoded custom error, the revert data — in
 * `shortMessage`, `metaMessages` and `cause`. A one-line `console.error(err.message)` routinely
 * prints a generic wrapper and drops the `NotPauseAuthority()` that would have told you what went
 * wrong. Set `LOG_STACKS=1` for the full trace.
 */
const started = Date.now();

function stamp(): string {
    return `[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`;
}

function fmt(detail: Record<string, unknown> | undefined): string {
    if (detail === undefined) return "";
    return (
        " " +
        Object.entries(detail)
            .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : String(v)}`)
            .join(" ")
    );
}

export type Log = (message: string, detail?: Record<string, unknown>) => void;

export function logInfo(scope: string, message: string, detail?: Record<string, unknown>): void {
    console.log(`${stamp()} ${scope} ${message}${fmt(detail)}`);
}

export function logWarn(scope: string, message: string, detail?: Record<string, unknown>): void {
    console.warn(`${stamp()} ${scope} WARN ${message}${fmt(detail)}`);
}

export function logError(scope: string, message: string, error: unknown): void {
    console.error(`${stamp()} ${scope} FAILED ${message}`);
    const e = error as {
        shortMessage?: string;
        metaMessages?: string[];
        details?: string;
        message?: string;
        stack?: string;
        cause?: { shortMessage?: string; message?: string };
    };
    if (e?.shortMessage) console.error(`    ${e.shortMessage}`);
    for (const meta of e?.metaMessages ?? []) console.error(`    ${meta}`);
    if (e?.details) console.error(`    ${e.details}`);
    if (e?.cause?.shortMessage ?? e?.cause?.message) {
        console.error(`    caused by: ${e.cause.shortMessage ?? e.cause.message}`);
    }
    if (!e?.shortMessage && e?.message) console.error(`    ${e.message}`);
    if (process.env["LOG_STACKS"] === "1" && e?.stack) console.error(e.stack);
}

/** A `Log` bound to one role, for passing into `roles/**` — which never imports this module. */
export function scopedLog(scope: string): Log {
    return (message, detail) => logInfo(scope, message, detail);
}
