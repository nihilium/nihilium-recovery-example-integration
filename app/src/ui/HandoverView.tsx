/**
 * Recoveries already on-chain, and the one button that finishes them.
 *
 * **Why this is a view of its own.** Every other surface in this app is keyed on the active seed —
 * which is precisely the seed a recovery says you no longer have. A submitted handover was therefore
 * invisible: its vault belonged to a wallet the app could not derive, and closing the recovery
 * dialog left no sign that anything was in flight. Switching seeds to look for it made it *less*
 * visible, not more.
 *
 * So this is keyed on the handover rows. It shows the same thing whatever the seed switcher says,
 * which is the only way a screen about a lost seed can work.
 *
 * **One button for the whole vault.** A vault is one gate over several accounts; moving it is one
 * decision. Executing EVM and Solana separately would charge the user for the asymmetry the vault
 * exists to remove.
 */
import { Fragment, useState } from "react";
import type { FeeEstimator } from "../demo/useFeeEstimate.js";
import type { TimelockRow } from "../demo/useTimelocks.js";
import {
    movableChains,
    reconcileHandover,
    type LiveHandover,
    type LiveStage,
} from "../integration/recovery/handovers.js";
import { approximate, nowSeconds } from "../integration/recovery/settlement/timelock.js";
import type { HandoverGroup, Handovers } from "../demo/useHandovers.js";
import { seedFingerprint, type SeedBook } from "../demo/seeds.js";
import { Button, Card, Heading, StatusMessage } from "./ds.js";
import { FeeEstimate } from "./FeeEstimate.js";
import { Notice } from "./Notice.js";
import { Transcript } from "./Transcript.js";

export function HandoverView({
    handovers,
    seeds,
    chainLabels,
    onGenerateSeed,
    fees,
    attempts,
}: {
    handovers: Handovers;
    seeds: SeedBook;
    chainLabels: Readonly<Record<string, string>>;
    onGenerateSeed: () => string;
    /** What finishing a handover costs on chain, priced at mainnet rates. */
    fees: FeeEstimator;
    /**
     * What the chain says about each handover's attempt — the **same** reads the timelock box
     * renders, so the two cannot disagree. See `reconcileHandover`.
     */
    attempts: readonly TimelockRow[];
}) {
    const { groups, moving, log, error } = handovers.state;

    return (
        <div className="stack">
            {groups.map((group) => (
                <HandoverCard
                    key={group.vaultId}
                    group={group}
                    seeds={seeds}
                    chainLabels={chainLabels}
                    busy={moving === group.vaultId}
                    onMove={(chainIds) => void handovers.move(group.vaultId, chainIds)}
                    onDestination={(mnemonic) =>
                        void handovers.setDestination(group.vaultId, mnemonic)
                    }
                    onDiscard={() => void handovers.discard(group.vaultId)}
                    onGenerateSeed={onGenerateSeed}
                    fees={fees}
                    attempts={attempts}
                />
            ))}

            {log.length > 0 && (
                <Transcript lines={log} running={moving !== null} label="Moving funds" />
            )}
            {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}
        </div>
    );
}

function HandoverCard({
    group,
    seeds,
    chainLabels,
    busy,
    onMove,
    onDestination,
    onDiscard,
    onGenerateSeed,
    fees,
    attempts,
}: {
    group: HandoverGroup;
    seeds: SeedBook;
    chainLabels: Readonly<Record<string, string>>;
    busy: boolean;
    onMove: (chainIds: readonly string[]) => void;
    onDestination: (mnemonic: string) => void;
    onDiscard: () => void;
    onGenerateSeed: () => string;
    fees: FeeEstimator;
    attempts: readonly TimelockRow[];
}) {
    const [picking, setPicking] = useState(false);
    const { progress } = group;

    // Each row as it actually stands. The row's own `stage` says what this app did; whether a
    // `submitted` row is still counting down is the chain's to say, and the old `progress.waiting`
    // — computed from the row alone — kept this button disabled after every chain had matured.
    const now = nowSeconds();
    const live: LiveHandover[] = group.records.map((record) =>
        reconcileHandover(
            record,
            attempts.find(
                (row) =>
                    row.vaultId === record.vaultId &&
                    row.chainId === record.chainId &&
                    row.accountId === record.accountId,
            ),
            now,
        ),
    );
    const movable = movableChains(group.records, live);
    const waiting = live.some((row) => row.stage === "counting" || row.stage === "paused");
    // Priced for what the button will do: the ready chains when some are, otherwise every chain the
    // vault covers — so a quote never names a chain the press would skip. The account and the vault
    // PDA exist by now: a handover is the tail of a recovery.
    const estimate = fees.estimate(
        "move-funds",
        { accountDeployed: true, replacing: false, vaultExists: true },
        movable.length > 0 ? movable : group.records.map((record) => record.chainId),
    );
    const done = progress.stage === "swept";
    // Every chain failed to submit, so there is no intent anywhere and nothing to execute. The
    // recovery is over; leaving a permanently broken card is worse than letting it be cleared.
    const dead = progress.stage === "failed";
    const ownerSeed = seeds.seeds.find(
        (entry) => seedFingerprint(entry.mnemonic) === group.ownerWalletId,
    );

    return (
        <Card padding="md">
            <div className="stack">
                <div className="card-head">
                    <Heading level={3}>{group.vaultId}</Heading>
                    <span className="muted">
                        {progress.total} chain{progress.total === 1 ? "" : "s"}
                    </span>
                </div>

                <div className="stack">
                    {group.records.map((record, index) => (
                        <div className="handover-row" key={record.id}>
                            <span>{chainLabels[record.chainId] ?? record.chainId}</span>
                            <span className="muted">{liveText(live[index]!)}</span>
                            <span className="muted mono">
                                {record.failure ?? live[index]!.reason ?? ""}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Control is fixed: it is named inside an intent signed by a key the ceremony has
                    already destroyed. Only where the funds land can still change. */}
                <dl className="rows">
                    <dt>control handed to</dt>
                    <dd>{ownerSeed?.label ?? group.ownerWalletId}</dd>
                </dl>
                {/* Per chain, because each row carries its own: the destination seed's Safe on EVM,
                    its vault on Solana. This used to print `records[0].sweepTo` under the belief
                    that every row shared one address, which made a two-chain sweep look like it
                    sent everything to a single EVM address. */}
                <div className="field">
                    <span className="field__label">Funds go to</span>
                    <dl className="rows">
                        {group.records.map((record) => (
                            <Fragment key={record.id}>
                                <dt>{chainLabels[record.chainId] ?? record.chainId}</dt>
                                <dd className="mono">{record.sweepTo || "—"}</dd>
                            </Fragment>
                        ))}
                    </dl>
                </div>

                {!group.canSign && (
                    <Notice tone="caution">
                        {ownerSeed?.label ?? "The seed control was handed to"} is not in this
                        browser. Add it to move these funds.
                    </Notice>
                )}

                {picking ? (
                    <div className="field">
                        <span className="field__label">Move the funds to</span>
                        <div className="gate-picker">
                            {seeds.seeds.map((entry) => (
                                <button
                                    key={entry.mnemonic}
                                    type="button"
                                    className="gate-option"
                                    onClick={() => {
                                        onDestination(entry.mnemonic);
                                        setPicking(false);
                                    }}
                                >
                                    <span className="gate-option__title">{entry.label}</span>
                                    <span className="gate-option__gate mono">
                                        {seedFingerprint(entry.mnemonic)}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className="row">
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    onDestination(onGenerateSeed());
                                    setPicking(false);
                                }}
                            >
                                Use a new seed
                            </Button>
                            <button type="button" className="linkish" onClick={() => setPicking(false)}>
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="card-foot">
                        <Button
                            onClick={() => onMove(movable)}
                            disabled={movable.length === 0 || busy || done || dead || !group.canSign}
                        >
                            {dead
                                ? "Nothing reached the chain"
                                : done
                                  ? "Funds moved"
                                  : busy
                                    ? "Moving…"
                                    : movable.length === 0
                                      ? waiting
                                          ? "Timelock still running"
                                          : "Nothing to move yet"
                                      : waiting
                                        ? `Move the ${movable.length} ready`
                                        : "Move everything"}
                        </Button>
                        {!done && !dead && (
                            <>
                                {/* Before the button that spends it, like the ceremony's price. */}
                                <FeeEstimate estimate={estimate} fees={fees} />
                                <button type="button" className="linkish" onClick={() => setPicking(true)}>
                                    Change destination
                                </button>
                            </>
                        )}
                        {/* Always, not only when dead. A half-failed handover is exactly the state
                            a user most needs to be able to clear, and offering the escape only for
                            the tidiest failure is offering it when it is least needed. */}
                        <button type="button" className="linkish" onClick={onDiscard}>
                            Discard
                        </button>
                    </div>
                )}

                {dead && (
                    <Notice tone="caution">
                        Nothing reached the chain. Start recovery again to retry (a new ceremony).
                    </Notice>
                )}

                {done && (
                    <StatusMessage tone="success">
                        All funds moved. Don&apos;t send anything back to the recovered account.
                    </StatusMessage>
                )}
            </div>
        </Card>
    );
}

/**
 * The row's line. Every word here is either something this app did or something the chain said —
 * the old table rendered the row's own `submitted` as "timelock running", which was a guess about
 * the chain that stayed true long after the chain said otherwise.
 */
const LIVE_TEXT: Record<Exclude<LiveStage, "counting" | "paused">, string> = {
    ready: "ready to move",
    executed: "control moved · funds still here",
    swept: "funds moved",
    aborted: "aborted on-chain",
    missing: "no attempt on-chain",
    unread: "not read yet",
    failed: "could not be carried through",
};

function liveText(row: LiveHandover): string {
    if (row.stage === "counting" || row.stage === "paused") {
        const verb = row.stage === "paused" ? "paused" : "timelock running";
        return row.remainingSeconds === null
            ? verb
            : `${verb} · ready in ${approximate(row.remainingSeconds)}`;
    }
    return LIVE_TEXT[row.stage];
}
