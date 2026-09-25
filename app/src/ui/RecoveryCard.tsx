/**
 * Account recovery, at rest: a collapsed bar saying what the gate is and whether anything is
 * watching it, and one button that changes it.
 *
 * Closed by default once a gate exists. Setting recovery up is a thing you do twice in a wallet's
 * life, so the expanded form — who the guardians are, the seal file — is detail you open when you
 * want it, not the shape of the page.
 *
 * What is deliberately *not* here is whether the account is protected on-chain. That is a fact about
 * the account, it already has a badge on the wallet card, and repeating it here made the gate look
 * like it was the thing that was half-finished. The gate is finished; the chain is the other half.
 *
 * Recovering is not here either — losing a wallet is a thing that happens to a wallet, so the way in
 * is on the wallet card. The only route back into the setup form is **Replace guardians**, which
 * buys a whole new ceremony, because that is what changing a gate costs.
 *
 * **One return, and the dialog always in the same slot.** This had two returns, and the bug that
 * cost was worth the restructure: a successful seal makes `flow.active` non-null in the *same
 * commit* that sets `phase: "sealed"`, so the card swapped trees, the dialog moved child position,
 * and React unmounted and remounted it — resetting the wizard to its first step in the one render
 * that was supposed to say "sealed". The ceremony had succeeded; the component that would have
 * reported it no longer existed. So the body may change shape, and the dialog may not move.
 */
import { useState } from "react";
import type { VetoState } from "@nihilium/recovery-core";
import {
    timelockLabel,
    type AttemptClock,
} from "../integration/recovery/settlement/timelock.js";
import type { DerivedAccount } from "../integration/chains/types.js";
import type { GateDescription, MethodRegistry } from "../integration/conditions/types.js";
import type { ProtectTarget } from "../integration/recovery/settlement/coverage.js";
import { displayRecordId, type VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, Card, Heading, StatusMessage } from "./ds.js";
import { AddressChip } from "./AddressChip.js";
import { downloadSeal } from "./downloadSeal.js";
import { StageBadge, WatchBadge } from "./HealthBadge.js";
import { stageOf, type RecoveryStage } from "./recoveryHealth.js";
import { Notice } from "./Notice.js";
import { SealDialog } from "./SealDialog.js";
import { Transcript } from "./Transcript.js";

export function RecoveryCard({
    flow,
    methods,
    methodError,
    account,
    chainLabel,
    onchainAttempt,
    onchainClock,
    watching,
    coverage,
    onProtectAll,
    onOpenHandover,
    onAbort,
    canAbort,
    aborting,
    abortLog,
}: {
    flow: RecoveryFlow;
    /** Null when the live ceremony is not configured — there is deliberately no free fallback. */
    methods: MethodRegistry | null;
    methodError: string | null;
    account: DerivedAccount | undefined;
    /** Only for copy — which chain the "add this one" line is offering. */
    chainLabel: string;
    /** The module's attempt state. `undefined` means the chain has not been read. */
    onchainAttempt: VetoState | null | undefined;
    /** The same read's clock, so the badge applies the shared definition of ready. */
    onchainClock: AttemptClock | null | undefined;
    /** Whether anything watches for a recovery this browser did not start. False everywhere today. */
    watching: boolean;
    /**
     * Every chain at once, not the one on screen.
     *
     * This card is about the gate, and a gate covers chains the chain switcher is not showing. The
     * per-chain protect button that used to live here could only ever offer the active chain, so a
     * wallet with funds on two chains saw one button and no sign of the other.
     */
    coverage: { targets: readonly ProtectTarget[]; stale: readonly string[] };
    onProtectAll: () => void;
    /** Switches to the Handover view, where the funds actually move. */
    onOpenHandover: () => void;
    /** Kills every in-flight attempt on this vault. Terminal, and signed by the wallet's own key. */
    onAbort: () => void;
    canAbort: boolean;
    aborting: boolean;
    abortLog: readonly string[];
}) {
    const [sealing, setSealing] = useState(false);

    // `flow.vault` is the gate this wallet holds; `flow.covers` is whether the chain on screen is in
    // it. Conflating the two is what made switching to Solana offer a second paid ceremony.
    const vault = flow.vault;
    const method = vault === null ? null : (methods?.get(vault.gate.methodId) ?? null);
    const gate = vault !== null && method !== null ? method.describeGate(vault.gate) : null;
    // Both halves: what this browser did, and what the chain reports. `spent` alone used to stand
    // for the whole recovery, which called an untouched account "completed".
    const stage = stageOf({
        vault,
        attempt: onchainAttempt,
        opening: flow.state.phase === "recovering",
        clock: onchainClock ?? null,
    });

    return (
        <Card padding="md">
            {vault === null ? (
                // Nothing sealed yet: no disclosure, because collapsing the one call to action
                // behind a triangle would hide the only thing there is to do.
                <div className="stack">
                    <Heading level={3}>Account recovery</Heading>
                    {methods === null ? (
                        <StatusMessage tone="error">
                            {methodError ?? "The live ceremony is not configured."}
                        </StatusMessage>
                    ) : (
                        <>
                            <p>Choose the guardians who can recover this account.</p>
                            <div className="row">
                                <Button
                                    onClick={() => setSealing(true)}
                                    disabled={account === undefined}
                                >
                                    Set up recovery
                                </Button>
                                {account === undefined && (
                                    <span className="muted">Deriving the account…</span>
                                )}
                            </div>
                        </>
                    )}
                </div>
            ) : (
                <SealedBody
                    vault={vault}
                    gate={gate}
                    stage={stage}
                    watching={watching}
                    coverage={coverage}
                    onProtectAll={onProtectAll}
                    holdsSeal={flow.state.seals.some((ref) => ref.vaultId === vault.vaultId)}
                    hostSync={flow.state.hostSync[vault.vaultId]}
                    // Built from storage at the click, never the copy taken at sealing: a chain
                    // added since then is otherwise missing from the file the user keeps.
                    onDownloadSeal={async () => downloadSeal(vault, await flow.exportSeal(vault))}
                    chainLabel={chainLabel}
                    covers={flow.covers}
                    onOpenHandover={onOpenHandover}
                    onReplace={() => setSealing(true)}
                    onAbort={onAbort}
                    canAbort={canAbort}
                    aborting={aborting}
                    abortLog={abortLog}
                />
            )}

            {/* Outside the body: a failure the user cannot see because the card is closed is a
                failure they will not act on. */}
            {flow.state.error !== null && !sealing && (
                <StatusMessage tone="error">{flow.state.error}</StatusMessage>
            )}

            {/* The fixed slot. Mounted only while open, so the wizard starts fresh on each run — but
                never moved, so a run in progress cannot be torn down by the card behind it. */}
            {methods !== null && sealing && (
                <SealDialog
                    key="seal-dialog"
                    open={sealing}
                    onClose={() => setSealing(false)}
                    flow={flow}
                    methods={methods}
                    // Passed even when spent. A new gate does not undo a recovery, but leaving the
                    // old row behind would give this account two vaults and let `vaultFor` pick
                    // whichever came first — so the replacement still discards it.
                    replacing={vault}
                />
            )}
        </Card>
    );
}

/** The disclosure. Split out only so `RecoveryCard` keeps one return and one dialog position. */
/** The stages an attempt can be killed from. Terminal ones have nothing left to refuse. */
function isAbortable(stage: RecoveryStage | null): boolean {
    return stage === "initiated" || stage === "paused" || stage === "executable";
}

function SealedBody({
    vault,
    gate,
    stage,
    watching,
    coverage,
    onProtectAll,
    holdsSeal,
    hostSync,
    onDownloadSeal,
    chainLabel,
    covers,
    onOpenHandover,
    onReplace,
    onAbort,
    canAbort,
    aborting,
    abortLog,
}: {
    vault: VaultRecord;
    gate: GateDescription | null;
    stage: RecoveryStage | null;
    watching: boolean;
    /** Whether the chain honours *this* gate. `stale` means it honours the one before it. */
    /**
     * Every chain at once, not the one on screen.
     *
     * This card is about the gate, and a gate covers chains the chain switcher is not showing. The
     * per-chain protect button that used to live here could only ever offer the active chain, so a
     * wallet with funds on two chains saw one button and no sign of the other.
     */
    coverage: { targets: readonly ProtectTarget[]; stale: readonly string[] };
    onProtectAll: () => void;
    /** Whether this browser holds the seal — the one thing a file cannot be rebuilt without. */
    holdsSeal: boolean;
    /** Whether the records are on the record host. `undefined` until the first sync has answered. */
    hostSync: { ok: boolean; message: string } | undefined;
    onDownloadSeal: () => Promise<void>;
    chainLabel: string;
    /** Whether the chain on screen is in this vault. */
    covers: boolean;
    /** This operation's transcript, and only this one's. */
    /** Mints a seed and switches to it — the only real answer to a spent vault. */
    /** Switches to the Handover view, where the funds actually move. */
    onOpenHandover: () => void;
    onReplace: () => void;
    onAbort: () => void;
    /** False when this browser no longer holds the seed the abort authority derives from. */
    canAbort: boolean;
    aborting: boolean;
    /** This operation's lines, and only this one's — see `transcripts.test.ts`. */
    abortLog: readonly string[];
}) {
    const abortable = isAbortable(stage);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    return (
        <details className="disclosure">
            <summary>
                <span className="disclosure__marker" aria-hidden="true" />
                <Heading level={3}>Account recovery</Heading>
                {/* The gate on the bar, so the closed card still answers "what protects this?" */}
                <span className="muted">
                    {gate?.headline ?? vault.gate.summary}
                    {!covers && ` · ${chainLabel} not in it yet`}
                </span>
                <span className="disclosure__spacer row">
                    {stage !== null && <StageBadge stage={stage} />}
                    <WatchBadge watching={watching} />
                    {/* The one action worth reaching without opening the card. Protecting a funded
                        chain is time-sensitive in a way the rest of the body is not, and it was the
                        only reason left to expand a card whose whole point is that it stays shut.

                        Only when a press would do something: `targets` is the chains it would
                        touch, so an empty one would be a button that opens a dialog to say there is
                        nothing to do. Reviewing coverage stays in the body, which has room to say
                        why a chain was skipped.

                        `preventDefault` is what stops the press toggling the disclosure — the click
                        reaches `<summary>` regardless, and it is the default action rather than the
                        propagation that opens the card. `stopPropagation` is belt and braces for
                        the same thing. CSS hides this once the card is open, so the body's copy of
                        the button is never a second one on screen. */}
                    {vault.spent === null && coverage.targets.length > 0 && (
                        <Button
                            className="disclosure__action"
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onProtectAll();
                            }}
                        >
                            Protect all chains with funds
                        </Button>
                    )}
                </span>
            </summary>

            <div className="stack disclosure__body">

                <ul className="reasons">
                    {gate?.slots.map((slot) => (
                        <li key={slot.index}>
                            {slot.index}. {slot.label}
                        </li>
                    ))}
                </ul>

                {vault.spent !== null && (
                    <>
                        {/* Status, not the SDK's paragraph: that sentence is in the transcript of the
                            recovery that wrote it. */}
                        <Notice tone="caution">
                            Vault spent · recovered {new Date(vault.spent.at).toLocaleDateString()}.
                            Set up a new gate.
                        </Notice>
                        {/* Minting a seed is not moving anything, and this button used to do only
                            that. The recovery it belongs to is already on-chain; what is left is
                            waiting out the timelock and sweeping, which lives in the Handover view. */}
                        <div className="row">
                            <Button onClick={onOpenHandover}>Go to the handover</Button>
                        </div>
                    </>
                )}
                {/* No add-chain button here either. It is not a separate step any more: protecting
                    a chain the gate has not reached adds it first, in one action. Two buttons for
                    one outcome made the free half look like a cost — and on a chain whose
                    registration is signed by the recovery key, pressing add on its own minted a key
                    that could never sign and was re-keyed a moment later. */}

                {/* The gate changed and some chain did not. Loud, and on the card where the
                    change was made — the action lives on the wallet too, but nobody looks there
                    after replacing guardians. Named per chain, because "the chain" used to mean
                    whichever one the switcher happened to be on. */}
                {coverage.stale.length > 0 && (
                    <Notice tone="caution">
                        {coverage.stale.join(" and ")} still{" "}
                        {coverage.stale.length === 1 ? "uses" : "use"} the old guardians. Protect all
                        chains to switch.
                    </Notice>
                )}

                {/* One button for every chain, because the gate is one thing. A per-chain button
                    here could only offer the chain on screen, which is how a funded chain stayed
                    unprotected with nothing saying so. The dialog names what it will touch and what
                    it will not, so it is worth opening even when there is nothing to do. */}
                {vault.spent === null && (
                    <div className="row">
                        <Button onClick={onProtectAll}>
                            {coverage.targets.length > 0
                                ? "Protect all chains with funds"
                                : "Review chain coverage"}
                        </Button>
                    </div>
                )}

                {/* The vault's own handle. Kept on the card rather than only in the dialog you just
                    closed: it is how a record host is asked for this vault's ciphertext, and it is
                    the one part of a recovery that is safe to write down or email. */}
                {/* What the next protect writes to each chain. Absent on vaults sealed before it
                    could be chosen, which use the operator's default. */}
                {vault.timelockSeconds !== undefined && (
                    <div className="row">
                        <span className="field__label">Timelock</span>
                        <span>{timelockLabel(vault.timelockSeconds)}</span>
                    </div>
                )}

                <div className="row">
                    <span className="field__label">Recovery id</span>
                    <AddressChip value={vault.recordId} display={displayRecordId(vault)} />
                </div>

                <div className="card-foot">
                    <span className="muted">
                        Seal file:{" "}
                        {!holdsSeal ? (
                            // Reported, not hidden: this browser no longer holds the seal, and only
                            // a copy on disk can recover elsewhere.
                            <span>not in this browser</span>
                        ) : (
                            // `TextLink` takes an href and nothing else, and this is an action
                            // rather than a destination — so a button wearing a link's clothes,
                            // which is the accessible way round.
                            <button
                                type="button"
                                className="linkish"
                                onClick={() => {
                                    setDownloadError(null);
                                    onDownloadSeal().catch((error: unknown) =>
                                        setDownloadError(
                                            error instanceof Error ? error.message : String(error),
                                        ),
                                    );
                                }}
                            >
                                Download
                            </button>
                        )}
                        {downloadError !== null && (
                            <span className="verdict verdict--blocking"> {downloadError}</span>
                        )}
                    </span>
                    {/* Records belong everywhere, and the host is where a fresh device finds them —
                        including every chain added after the seal file was saved. Said as a fact,
                        and never as "ok" before the host has actually answered. */}
                    <span className={hostSync?.ok === false ? "verdict verdict--blocking" : "muted"}>
                        Records: {hostSync === undefined ? "checking the record host…" : hostSync.message}
                    </span>
                    {/* Abort sits beside Replace because they are the two things an owner does to
                        a gate they did not ask for: refuse this attempt, or change who can open the
                        next one. Only while something is actually in flight — abort is terminal and
                        has nothing to act on otherwise. */}
                    {abortable && (
                        <Button variant="ghost" onClick={onAbort} disabled={!canAbort || aborting}>
                            {aborting
                                ? "Aborting…"
                                : canAbort
                                  ? "Abort this recovery"
                                  : "Abort needs this vault's own seed"}
                        </Button>
                    )}
                    <Button variant="ghost" onClick={onReplace}>
                        {vault.spent === null ? "Replace guardians" : "Set up a new gate"}
                    </Button>
                </div>

                {abortLog.length > 0 && (
                    <Transcript lines={abortLog} running={aborting} label="Aborting" />
                )}

            </div>
        </details>
    );
}
