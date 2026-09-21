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
import type { DerivedAccount } from "../integration/chains/types.js";
import type { GateDescription, MethodRegistry } from "../integration/conditions/types.js";
import type { SealFile } from "../integration/recovery/sealFile.js";
import { displayRecordId, type VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, Card, Heading, StatusMessage } from "./ds.js";
import { AddressChip } from "./AddressChip.js";
import { downloadSeal } from "./downloadSeal.js";
import { Explain } from "./Explain.js";
import { StageBadge, WatchBadge } from "./HealthBadge.js";
import { stageOf, type RecoveryStage } from "./recoveryHealth.js";
import { Notice } from "./Notice.js";
import type { Protection } from "./protection.js";
import { SealDialog } from "./SealDialog.js";

export function RecoveryCard({
    flow,
    methods,
    methodError,
    account,
    chainLabel,
    onchainAttempt,
    watching,
    protection,
    protecting,
    onProtect,
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
    /** Whether anything watches for a recovery this browser did not start. False everywhere today. */
    watching: boolean;
    protection: Protection;
    protecting: boolean;
    onProtect: () => void;
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
                            <p>Name a few people you trust. Any two of them can get you back in.</p>
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
                    protection={protection}
                    protecting={protecting}
                    onProtect={onProtect}
                    sealFile={flow.state.sealFile}
                    chainLabel={chainLabel}
                    covers={flow.covers}
                    addChainLog={flow.state.logs.addChain}
                    onAddChain={() => void flow.addChain()}
                    onReplace={() => setSealing(true)}
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
function SealedBody({
    vault,
    gate,
    stage,
    watching,
    protection,
    protecting,
    onProtect,
    sealFile,
    chainLabel,
    covers,
    addChainLog,
    onAddChain,
    onReplace,
}: {
    vault: VaultRecord;
    gate: GateDescription | null;
    stage: RecoveryStage | null;
    watching: boolean;
    /** Whether the chain honours *this* gate. `stale` means it honours the one before it. */
    protection: Protection;
    protecting: boolean;
    onProtect: () => void;
    sealFile: SealFile | null;
    chainLabel: string;
    /** Whether the chain on screen is in this vault. */
    covers: boolean;
    /** This operation's transcript, and only this one's. */
    addChainLog: readonly string[];
    onAddChain: () => void;
    onReplace: () => void;
}) {
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
                </span>
            </summary>

            <div className="stack disclosure__body">
                {gate !== null && <p className="muted">{gate.survives}</p>}

                <ul className="reasons">
                    {gate?.slots.map((slot) => (
                        <li key={slot.index}>
                            {slot.index}. {slot.label}
                        </li>
                    ))}
                </ul>

                {vault.spent !== null && <Notice tone="caution">{vault.spent.reason}</Notice>}

                {/* One vault, every chain. A ceremony is paid, plural and slow; this is a local
                    encryption against a key the vault already published. */}
                {!covers && vault.spent === null && (
                    <div className="row">
                        <Button onClick={onAddChain}>Add {chainLabel} to this vault</Button>
                        <span className="muted">
                            Free and instant — the same guardians, no ceremony, no payment.
                        </span>
                    </div>
                )}

                {/* Rendered where it happens. These lines had no home at all before, so the only
                    way they were ever seen was by leaking into whichever dialog opened next — and
                    the millisecond count is the proof of "free", not a decoration. */}
                {addChainLog.length > 0 && (
                    <pre className="transcript">{addChainLog.join("\n")}</pre>
                )}

                {/* The gate changed and the chain did not. Loud, and on the card where the change
                    was made — the action lives on the wallet too, but nobody looks there after
                    replacing guardians. */}
                {protection === "stale" && (
                    <>
                        <Notice tone="caution">
                            The chain still points at the gate you replaced. Until this lands, the{" "}
                            <strong>old guardians</strong> are the ones who can recover this account,
                            and the new ones cannot — the module only honours the key it holds.
                        </Notice>
                        <div className="row">
                            <Button onClick={onProtect} disabled={protecting}>
                                {protecting ? "Sending…" : `Update ${chainLabel} to this gate`}
                            </Button>
                            <span className="muted">One transaction, paid by the account.</span>
                        </div>
                    </>
                )}

                {/* Sealed and never registered. Same asymmetry, different cause. */}
                {protection === "sealed" && (
                    <div className="row">
                        <Button onClick={onProtect} disabled={protecting}>
                            {protecting ? "Sending…" : `Protect ${chainLabel} with this gate`}
                        </Button>
                        <span className="muted">
                            Nothing on-chain honours this gate yet.
                        </span>
                    </div>
                )}

                {/* The vault's own handle. Kept on the card rather than only in the dialog you just
                    closed: it is how a record host is asked for this vault's ciphertext, and it is
                    the one part of a recovery that is safe to write down or email. */}
                <div className="row">
                    <span className="field__label">Recovery id</span>
                    <AddressChip value={vault.recordId} display={displayRecordId(vault)} />
                </div>

                <div className="card-foot">
                    <span className="muted">
                        Seal file:{" "}
                        {sealFile === null ? (
                            // Reported, not hidden: this browser holds the seal but not the file,
                            // and only the copy on disk can recover elsewhere.
                            <span>handed over at seal time</span>
                        ) : (
                            // `TextLink` takes an href and nothing else, and this is an action
                            // rather than a destination — so a button wearing a link's clothes,
                            // which is the accessible way round.
                            <button
                                type="button"
                                className="linkish"
                                onClick={() => downloadSeal(vault, sealFile)}
                            >
                                Download
                            </button>
                        )}
                    </span>
                    <Button variant="ghost" onClick={onReplace}>
                        {vault.spent === null ? "Replace guardians" : "Set up a new gate"}
                    </Button>
                </div>

                <Explain>
                    {vault.spent === null ? (
                        <p>
                            The two badges answer two questions. The stage is what the chain and this
                            browser know about <em>this</em> account. The watch badge is whether
                            anything would notice a recovery somebody else started — and nothing
                            does, because the watchtower role is not built yet.
                        </p>
                    ) : (
                        <p>
                            A new gate on this account does not undo the recovery. It decrypted every
                            record, so the root secret is known to whoever ran it, and a fresh set of
                            guardians would be guarding a key someone else already has. The real
                            answer is a new account, and moving what is in this one to it — the new
                            gate below only stops this browser holding a spent seal.
                        </p>
                    )}
                    <p>
                        The recovery id is a meaningless lookup handle: it yields ciphertext and
                        nothing else, so it is safe to email while the seal is not — that difference
                        <em> is</em> the two-domain rule. You do not have to quote it to recover,
                        because the seal already carries it; it is what you give a record host to
                        fetch this vault&apos;s records when the device recovering has none of its
                        own.
                    </p>
                    <p>
                        Adding a chain costs nothing because the gate does not change: the same
                        guardians open it, and the vault already published the key its records are
                        encrypted to. The cost is on the other side — a recovery opens{" "}
                        <em>every</em> chain in the vault, so each one added widens what a single
                        ceremony exposes.
                    </p>
                    <p>
                        Replacing guardians changes the vault, not the chain. The module has no
                        setter — `onInstall` reverts once a config exists — so updating it is an
                        uninstall and an install in one operation, and until it runs the account is
                        still guarded by the key the old gate produced. The old records are
                        append-only and were never deleted, so an old seal file plus the old
                        guardians would still work.
                    </p>
                    <p>
                        Replacing guardians buys a whole new set of seals under a new vault id. The
                        old gate keeps working until the new one finishes, and is discarded only once
                        it has.
                    </p>
                </Explain>
            </div>
        </details>
    );
}
