/**
 * How long until the account can actually be taken back.
 *
 * Its own box, above the cards, because it is the one fact that outranks everything else on screen
 * while a recovery is running — and because it belongs to the *vault*, not to the chain the user
 * happens to be looking at.
 *
 * **The headline is the longest wait, not the shortest.** A vault covers several chains and a
 * recovery is not finished until the slowest has matured; showing the nearer number would tell
 * somebody the account is theirs while one chain still refuses. The per-chain rows are underneath so
 * the headline is never the only thing said.
 *
 * The meter is **determinate**, unlike `Transcript`'s — and the difference is the point. A ceremony
 * finishes when guardians answer their email, which is unknowable; a timelock is a number the chain
 * committed to, so a bar filling toward it is reporting rather than guessing. The fill comes from
 * `progressFraction`, which derives it from the *remainder* rather than from the stored
 * `accruedSeconds` — the two chains write that counter differently, and reading it literally left
 * Solana's bar at zero beside a row that said "ready". Under a pause it falls back to the stored
 * counter, which is why the bar visibly stops.
 *
 * **When a failed read counts, and when it is noise.** `unknown` must never render as all clear —
 * but that rule bites only where there is something to be unclear *about*. With a recovery in
 * flight, a chain nobody could reach might be the one that matured, so it is reported and it
 * outranks "ready" in the headline. With no recovery anywhere, the same failed read is a failed read
 * of nothing, and a box announcing an unknown timelock on a wallet that has never started one is
 * inventing an alarm. So `expected` decides: it comes from the handover rows, which are the app's
 * own record that something was submitted, rather than from the chain it just failed to ask.
 *
 * That leaves one gap, and it is deliberately somebody else's: a recovery submitted from a browser
 * this one has never seen, on a chain this one cannot currently read, shows nothing. Noticing a
 * recovery you did not start is the watchtower's job — `buildWatchRegistration` fires during the
 * unsealing, before any of this — and that role is not built here. A readable chain still reports a
 * foreign attempt, because `projected` comes from the chain rather than from our own rows.
 */
import { useEffect, useState } from "react";
import type { VetoState } from "@nihilium/recovery-core";
import {
    approximate,
    hasMatured,
    nowSeconds,
    progressFraction,
    projectTimelock,
} from "../integration/recovery/settlement/timelock.js";
import type { TimelockRow } from "../demo/useTimelocks.js";
import { Card, Heading } from "./ds.js";

/** One second, for the countdown only. The chain is polled far less often — see `useTimelocks`. */
const TICK_MS = 1_000;

const STATE_LABEL: Record<VetoState, string> = {
    INITIATED: "submitted",
    PAUSED: "paused",
    EXECUTABLE: "ready",
    EXECUTED: "control moved",
    ABORTED: "aborted",
};

export function TimelockBox({
    rows,
    expected,
}: {
    rows: readonly TimelockRow[];
    /** Whether this app knows a recovery was submitted for this vault. See the header. */
    expected: boolean;
}) {
    const [now, setNow] = useState(nowSeconds);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(nowSeconds()), TICK_MS);
        return () => window.clearInterval(timer);
    }, []);

    // An attempt the chain reports, always. A chain that could not be read, only when something is
    // known to be in flight — otherwise the box exists to report an unknown nobody asked about.
    const attempts = rows.filter((row) => row.projected !== null);
    const seen =
        attempts.length > 0 || expected
            ? rows.filter((row) => row.projected !== null || row.unreadable !== null)
            : [];
    if (seen.length === 0) return null;

    // Rows now come from every handover plus the active wallet, so they can belong to different
    // vaults. Two "EVM · Sepolia" rows with nothing to tell them apart would be two answers to one
    // question, so the vault is named whenever more than one is on screen.
    const manyVaults = new Set(seen.map((row) => row.vaultId)).size > 1;

    const views = seen.map((row) => ({
        row,
        projection: row.clock === null ? null : projectTimelock(row.clock, now),
    }));

    const running = views
        .map((view) => view.projection?.remainingSeconds)
        .filter((value): value is number => value !== undefined && value !== null);
    const unreadable = views.filter((view) => view.row.unreadable !== null);
    // The longest, deliberately. See the header.
    const longest = running.length === 0 ? null : Math.max(...running);
    // `hasMatured`, the same rule every other surface uses. See `timelock.ts`.
    const anyReady = views.some((view) => hasMatured(view.row.projected, view.row.clock, now));

    return (
        <Card padding="md">
            <div className="stack">
                <div className="card-head">
                    <Heading level={3}>Timelock</Heading>
                    {unreadable.length > 0 && (
                        <span className="muted">
                            {unreadable.length} chain{unreadable.length === 1 ? "" : "s"} unreadable
                        </span>
                    )}
                </div>

                <p className="timelock__headline">{headline(longest, anyReady, unreadable.length)}</p>

                <div className="timelock__rows">
                    {views.map(({ row, projection }) => (
                        <div className="timelock__row" key={row.chainId}>
                            <span className="timelock__chain">
                                {manyVaults ? `${row.vaultId} · ${row.chainLabel}` : row.chainLabel}
                            </span>
                            <Meter
                                fraction={
                                    row.clock === null ? null : progressFraction(row.clock, now)
                                }
                                paused={row.projected === "PAUSED"}
                            />
                            <span className="timelock__detail mono">{detail(row, projection, now)}</span>
                        </div>
                    ))}
                </div>

            </div>
        </Card>
    );
}

function headline(longest: number | null, anyReady: boolean, unreadable: number): string {
    if (longest !== null && longest > 0) return `${approximate(longest)} left`;
    // Said before "ready": a chain nobody could read is not a chain that is clear, and this is the
    // one screen where mistaking the two hands the account over early.
    if (unreadable > 0) return "Time left is unknown — a chain could not be read";
    if (anyReady) return "Ready — the timelock has matured";
    return "No timelock is running";
}

function detail(
    row: TimelockRow,
    projection: ReturnType<typeof projectTimelock> | null,
    now: number,
): string {
    // The reason, not the fact. "Could not read this chain" is true of a wrong RPC URL, a vault
    // that does not exist, a decode mismatch and a network blip alike — and a user cannot act on
    // any of them without being told which. Same failure the relayer had.
    if (row.unreadable !== null) return `could not read: ${row.unreadable}`;
    if (row.projected === null) return "no recovery";

    const label = STATE_LABEL[row.projected];
    const remaining = projection?.remainingSeconds ?? null;

    // Matured is matured, however the chain phrases it — `hasMatured` is the one definition.
    if (hasMatured(row.projected, row.clock, now)) return "ready";

    if (row.projected === "PAUSED" && projection?.ceilingLiftsInSeconds !== null) {
        return `${label} · ceiling lifts in ${approximate(projection!.ceilingLiftsInSeconds!)} · ready in ${approximate(projection!.remainingSeconds!)}`;
    }
    if (remaining !== null) {
        return `${label} · ready in ${approximate(remaining)}`;
    }
    return label;
}

/** `null` where there is nothing to fill, which renders as an empty track rather than a full one. */
function Meter({ fraction, paused }: { fraction: number | null; paused: boolean }) {
    return (
        <div
            className={`meter${paused ? " meter--paused" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(fraction === null ? {} : { "aria-valuenow": Math.round(fraction * 100) })}
        >
            <span className="meter__fill" style={{ inlineSize: `${(fraction ?? 0) * 100}%` }} />
        </div>
    );
}
