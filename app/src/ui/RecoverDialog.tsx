/**
 * Running the gate, and saying where control should end up.
 *
 * Two things were missing and one was wrong. Missing: the **target** — a recovery that hands back a
 * key and stops has not recovered anything, and nothing here ever asked the question the whole
 * mechanism exists for. Missing: the rows — who was asked, what phase they are in, how long it has
 * taken, and what key came out. Wrong: it read as an explanation of a recovery rather than a report
 * of one.
 *
 * The recovered key is the authority that *signs* the handover. The target is where control lands.
 * They are different, they default to different values, and conflating them would hand the account
 * to a key derived from a vault that is now spent.
 *
 * **Three steps, and the middle one is load-bearing.** Which vault — because recovery is for a seed
 * that is gone, so the vault being opened is usually not the active wallet's. Then which *seed*
 * receives control, and it may not be the vault's own: a recovery decrypts every record, so that
 * seed's root secret is exposed to whoever ran it, and handing the account back to it would be
 * handing it to something the ceremony just published. The SDK is explicit that the answer is a new
 * account, not a new epoch — this is that rule as a control the user cannot get wrong.
 *
 * A seed rather than a pasted address, because the destination is chain-shaped: an EOA on EVM, an
 * ed25519 key on Solana. One `0x…` cannot be both, and typing one used to send an EVM address to
 * Solana as its new owner. See `demo/destinations.ts`.
 */
import { Fragment, useEffect, useState } from "react";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, StatusMessage } from "./ds.js";
import type { FeeEstimator } from "../demo/useFeeEstimate.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { FeeEstimate } from "./FeeEstimate.js";
import { Notice } from "./Notice.js";
import { Transcript } from "./Transcript.js";
import { RecoveredKeys } from "./RecoveredKey.js";
import { RecoveryVaultPicker } from "./RecoveryVaultPicker.js";
import { destinationFor, eligibleOwners, type Destination } from "../demo/destinations.js";
import { seedFingerprint, type SeedBook, type SeedEntry } from "../demo/seeds.js";
import type { CachedRecovery, RecoveryCatalogue } from "../integration/recovery/recoveryCatalogue.js";

export interface RecoveryTarget {
    kind: "derived" | "pasted";
    address: string;
}

type Step = "vault" | "owner" | "guardians";

export function RecoverDialog({
    open,
    onClose,
    flow,
    vault,
    onChooseVault,
    startAtVaultStep,
    catalogue,
    chainLabels,
    seeds,
    onGenerateSeed,
    onImportSeal,
    onDelete,
    onOpenHandover,
    fees,
}: {
    open: boolean;
    onClose: () => void;
    flow: RecoveryFlow;
    /**
     * The vault being recovered. Owned by the caller, not by this dialog, because the on-chain half
     * has to follow the same choice — held here, picking a vault in step one
     * would leave the handover pointed at whatever the chain tab happened to show.
     */
    vault: VaultRecord | null;
    onChooseVault: (vault: VaultRecord) => void;
    /** True when opened from "Start recovery" rather than from a card that already knows the vault. */
    startAtVaultStep: boolean;
    catalogue: RecoveryCatalogue;
    chainLabels: Readonly<Record<string, string>>;
    seeds: SeedBook;
    /** Mints a seed and returns its phrase, so this dialog can select it immediately. */
    onGenerateSeed: () => string;
    onImportSeal: (file: File) => Promise<void>;
    onDelete: (row: CachedRecovery) => void;
    /**
     * Switches to the Handover view, which finishes the recovery on **every** chain at once.
     *
     * The dialog used to drive `initiate` and `execute` itself, for the chain the switcher happened
     * to show. `submitAll` already opens an attempt on every chain the moment the ceremony returns,
     * so that button could only ever be a second attempt on a chain that already had one.
     */
    onOpenHandover: () => void;
    /** What the chain half costs, beside what the ceremony costs. */
    fees: FeeEstimator;
}) {
    const { state } = flow;
    const [retrying, setRetrying] = useState(false);
    /**
     * Chains whose intent never reached the relayer, as recorded at submit time.
     *
     * Not inferred from whether a key is still held: `wipe()` zeroes the bytes and leaves the array,
     * so that test stayed true after a completely successful recovery and left a retry button on a
     * screen with nothing to retry.
     */
    const unsubmitted = state.result?.unsubmitted ?? [];
    // Mounted only while it is open (see `RecoveryCard`), so every field starts fresh each run.
    const [step, setStep] = useState<Step>(startAtVaultStep ? "vault" : "owner");
    const [owner, setOwner] = useState<string | null>(null);
    const [picked, setPicked] = useState<number[]>([]);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const gate = vault?.gate ?? null;
    const running = state.phase === "recovering";
    const complete = gate !== null && picked.length === gate.threshold;

    /**
     * Seeds that may receive control — never the one the vault protects.
     *
     * A recovery decrypts every record in the vault, so that wallet's root secret is now known to
     * whoever ran it. Handing the account back to the same seed would hand it to a key the ceremony
     * just exposed, which is why the SDK says the answer is a new account rather than a new epoch.
     * Excluded here rather than warned about, because a warning is a thing a user clicks past.
     */
    const eligible =
        vault === null
            ? seeds.seeds
            : eligibleOwners(seeds.seeds, vault.walletId, seedFingerprint);
    /**
     * Where control lands, on **every chain this vault covers** — not on the chain the switcher
     * happens to show.
     *
     * One ceremony recovers every chain's key at once, and `submitAll` then signs one intent per
     * chain, each naming that chain's own destination. `destinationsFor` has always derived them per
     * chain; this screen was the last place still describing the whole thing as if it were the
     * active chain's business, which read as though recovery covered one chain.
     */
    const vaultChains = (vault?.chains ?? []).map((row) => ({
        chainId: row.chainId,
        label: chainLabels[row.chainId] ?? row.chainId,
        destination: owner === null ? null : destinationFor(owner, row.chainId),
    }));
    // At least one, not all: a vault covering a chain this build has no destination for still
    // recovers the others, and `submitAll` reports that chain as a failed row rather than refusing.
    const targetValid = vaultChains.some((row) => row.destination !== null);

    // One timer for the whole table rather than one per row: the elapsed column is the only thing
    // that changes between ticks, and n intervals to render n cells is n times the re-renders.
    useEffect(() => {
        if (!running) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running]);

    function start(): void {
        if (vault === null || owner === null) return;
        setStartedAt(Date.now());
        // The vault chosen in step one — which may belong to a seed this browser no longer holds,
        // and usually does — and the seed chosen in step two, which control is handed to.
        void flow.recover(vault, picked, owner);
    }

    function close(): void {
        // The key does not outlive the screen that needed it.
        flow.forgetKey();
        onClose();
    }


    return (
        <Dialog
            open={open}
            title="Recover this account"
            onClose={close}
            // From `Start recovery` onward this has emailed real people; there is no undo to offer.
            dismissible={!running}
            footer={
                state.result !== null ? (
                    <DialogActions>
                        <Button onClick={close}>Close</Button>
                    </DialogActions>
                ) : step === "vault" ? (
                    <DialogActions>
                        <Button
                            onClick={() => setStep("owner")}
                            disabled={vault === null}
                        >
                            {vault === null ? "Choose a vault" : "Next"}
                        </Button>
                    </DialogActions>
                ) : step === "owner" ? (
                    <DialogActions
                        {...(startAtVaultStep
                            ? { back: { label: "Back", onClick: () => setStep("vault") } }
                            : {})}
                    >
                        <Button onClick={() => setStep("guardians")} disabled={!targetValid}>
                            {owner === null
                                ? "Choose where control goes"
                                : !targetValid
                                  ? "No destination on any chain this vault covers"
                                  : "Next"}
                        </Button>
                    </DialogActions>
                ) : (
                    <DialogActions back={{ label: "Back", onClick: () => setStep("owner"), disabled: running }}>
                        <Button
                            onClick={start}
                            disabled={!complete || !targetValid || owner === null || running}
                        >
                            {running
                                ? "Waiting on the guardians…"
                                : !complete
                                  ? `Pick ${(gate?.threshold ?? 0) - picked.length} more`
                                  : "Start recovery"}
                        </Button>
                    </DialogActions>
                )
            }
        >
            <div className="stack">
                {state.result === null && step === "vault" && (
                    <RecoveryVaultPicker
                        catalogue={catalogue}
                        chainLabels={chainLabels}
                        chosen={vault}
                        onChoose={onChooseVault}
                        onDelete={onDelete}
                        onImportSeal={onImportSeal}
                    />
                )}

                {state.result === null && step === "owner" && vault !== null && (
                    <OwnerStep
                        eligible={eligible}
                        owner={owner}
                        vaultChains={vaultChains}
                        onChoose={setOwner}
                        onGenerate={() => setOwner(onGenerateSeed())}
                    />
                )}

                {state.result === null && step === "guardians" && gate !== null && (
                    <>
                        <div className="field">
                            <span className="field__label">
                                Ask {gate.threshold} of {gate.subjectCount}
                            </span>
                            <div className="gate-picker">
                                {gate.subjects.map((subject) => {
                                    const chosen = picked.includes(subject.index);
                                    const full = !chosen && picked.length >= gate.threshold;
                                    return (
                                        <button
                                            key={subject.index}
                                            type="button"
                                            className={
                                                chosen
                                                    ? "gate-option gate-option--active"
                                                    : "gate-option"
                                            }
                                            aria-pressed={chosen}
                                            // Capped here rather than letting the quorum refuse it
                                            // minutes later.
                                            disabled={full || running}
                                            onClick={() =>
                                                setPicked(
                                                    chosen
                                                        ? picked.filter((i) => i !== subject.index)
                                                        : [...picked, subject.index],
                                                )
                                            }
                                        >
                                            <span className="gate-option__title">
                                                #{subject.index} {subject.label}
                                            </span>
                                            <span className="gate-option__gate">
                                                {chosen
                                                    ? "will be emailed"
                                                    : full
                                                      ? "—"
                                                      : "tap to use"}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Every chain the vault covers, each with its own key. One `0x…` shown
                            against one chain label was the screen claiming a recovery is a
                            single-chain errand — it is one ceremony over all of them. */}
                        <div className="field">
                            <span className="field__label">Control goes to</span>
                            <dl className="rows">
                                {vaultChains.map((row) => (
                                    <Fragment key={row.chainId}>
                                        <dt>{row.label}</dt>
                                        <dd className="mono">
                                            {row.destination?.address ??
                                                "no destination in this build — this chain will be reported as failed"}
                                        </dd>
                                    </Fragment>
                                ))}
                            </dl>
                        </div>

                        {/* The chain's price, beside the ceremony's. They are separate costs paid to
                            separate parties, and the relayer carries all of this one — which the
                            breakdown says, because a reader who assumed otherwise would be budgeting
                            for gas they never spend. */}
                        {vault !== null && (
                            <FeeEstimate
                                estimate={fees.estimate(
                                    "recover",
                                    { accountDeployed: true, replacing: false, vaultExists: true },
                                    vault.chains.map((row) => row.chainId),
                                )}
                                fees={fees}
                            />
                        )}
                    </>
                )}

                {state.members.length > 0 && (
                    <table className="members-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>guardian</th>
                                <th>phase</th>
                                <th>elapsed</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.members.map((member) => {
                                const asked = member.phase.kind !== "idle";
                                return (
                                    <tr key={member.index} data-contacted={String(asked)}>
                                        <td>{member.index}</td>
                                        <td>{member.label}</td>
                                        <td>
                                            {phaseLabel(member.phase.kind)}
                                            {member.message !== undefined && (
                                                <>
                                                    {" "}
                                                    <span className="muted">{member.message}</span>
                                                </>
                                            )}
                                        </td>
                                        <td>
                                            {asked && startedAt !== null
                                                ? elapsed(startedAt, now)
                                                : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}

                {state.result !== null && (
                    <>
                        <RecoveredKeys
                            keys={state.result.keys}
                            ceremonies={state.result.ceremonies}
                            contacted={state.result.contacted}
                            untouched={state.result.untouched}
                        />
                        {unsubmitted.length > 0 && (
                            <>
                                <Notice tone="caution">
                                    {unsubmitted.length} chain
                                    {unsubmitted.length === 1 ? "" : "s"} not submitted:{" "}
                                    {unsubmitted.join(", ")}. Retry before closing — closing
                                    discards the keys.
                                </Notice>
                                <div className="row">
                                    <Button
                                        onClick={() => {
                                            if (vault === null || owner === null) return;
                                            setRetrying(true);
                                            void flow
                                                .retryHandover(vault, owner)
                                                .finally(() => setRetrying(false));
                                        }}
                                        disabled={retrying}
                                    >
                                        {retrying ? "Submitting…" : "Try those chains again"}
                                    </Button>
                                </div>
                            </>
                        )}

                        {/* What this recovery cost, as status. The SDK's full sentence is in the
                            Recovering transcript below. */}
                        <Notice tone="caution">
                            Vault spent · {state.result.keys.length} chain key
                            {state.result.keys.length === 1 ? "" : "s"} exposed. Don&apos;t reuse
                            this seed.
                        </Notice>
                        {/* Status, then the one action left.
                            The strip that used to sit here drove `initiate` and `execute` for the
                            chain on screen — a second attempt on a chain `submitAll` had already
                            opened, which both modules refuse with `AttemptInFlight`. One ceremony
                            covers the whole vault, so finishing it is one screen for all of it. */}
                        <div className="field">
                            <span className="field__label">Submitted · control moves when the timelock matures</span>
                            <dl className="rows">
                                {vaultChains.map((row) => (
                                    <Fragment key={row.chainId}>
                                        <dt>{row.label}</dt>
                                        <dd className="mono">
                                            {unsubmitted.includes(row.chainId)
                                                ? "not submitted"
                                                : `control to ${row.destination?.address ?? "—"}`}
                                        </dd>
                                    </Fragment>
                                ))}
                            </dl>
                        </div>

                        <div className="row">
                            <Button onClick={onOpenHandover}>Go to the handover</Button>
                        </div>
                    </>
                )}

                {/* This operation's transcript only. A shared one showed the seal's lines here. */}
                <Transcript
                    lines={state.logs.recover}
                    running={running}
                    label="Recovering"
                />

                {state.error !== null && <StatusMessage tone="error">{state.error}</StatusMessage>}
            </div>
        </Dialog>
    );
}

function phaseLabel(kind: string): string {
    switch (kind) {
        case "requesting":
            return "asking";
        case "awaiting-human":
            return "awaiting reply";
        case "proving":
            return "proving";
        case "done":
            return "done";
        case "failed":
            return "failed";
        default:
            return "not contacted";
    }
}

function elapsed(from: number, to: number): string {
    const seconds = Math.max(0, Math.floor((to - from) / 1000));
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Where control lands — named as a **seed**, and never the vault's own.
 *
 * Two rules, and both are the SDK's rather than this screen's:
 *
 * - **Not the vault's seed.** A recovery decrypts every record in the vault, so that wallet's root
 *   secret is now known to whoever ran the ceremony. Handing the account back to it would hand it to
 *   a key the recovery just exposed. The SDK says the answer is a new *account*, not a new epoch;
 *   excluding the seed here makes that a thing the user cannot get wrong, rather than a warning they
 *   click past.
 * - **Not the recovered key either.** That key signs the handover and comes from the same spent
 *   vault. It is never offered as a destination anywhere.
 *
 * A seed rather than an address because the destination is chain-shaped — an EOA on EVM, an ed25519
 * key on Solana. A single pasted string cannot be both, and the field that used to be here sent an
 * EVM address to Solana as its new owner.
 */
function OwnerStep({
    eligible,
    owner,
    vaultChains,
    onChoose,
    onGenerate,
}: {
    eligible: readonly SeedEntry[];
    owner: string | null;
    /** Every chain the vault covers, with where control would land on each. */
    vaultChains: readonly { chainId: string; label: string; destination: Destination | null }[];
    onChoose: (mnemonic: string) => void;
    onGenerate: () => void;
}) {
    return (
        <div className="stack">
            <div className="field">
                <span className="field__label">Hand control to</span>

                {eligible.length === 0 ? (
                    // The ordinary case on a wallet with one seed: the only seed here is the one
                    // this vault protects, and it is the one seed that must not receive control.
                    <Notice tone="caution">
                        Add another seed to receive control.
                    </Notice>
                ) : (
                    <div className="gate-picker">
                        {eligible.map((entry) => {
                            const active = entry.mnemonic === owner;
                            return (
                                <button
                                    key={entry.mnemonic}
                                    type="button"
                                    className={
                                        active ? "gate-option gate-option--active" : "gate-option"
                                    }
                                    aria-pressed={active}
                                    onClick={() => onChoose(entry.mnemonic)}
                                >
                                    <span className="gate-option__title">{entry.label}</span>
                                    {/* A key per chain, because that is what a seed is here. Showing
                                        one address made a two-chain recovery look like one. */}
                                    {vaultChains.map((row) => (
                                        <span className="gate-option__gate mono" key={row.chainId}>
                                            {row.label}{" "}
                                            {destinationFor(entry.mnemonic, row.chainId)?.address ??
                                                "— no destination in this build"}
                                        </span>
                                    ))}
                                </button>
                            );
                        })}
                    </div>
                )}

                <div className="row">
                    <Button variant="ghost" onClick={onGenerate}>
                        {eligible.length === 0 ? "Make a seed for it" : "Use a new seed instead"}
                    </Button>
                </div>
            </div>

            {owner !== null && (
                <dl className="rows">
                    {vaultChains.map((row) => (
                        <Fragment key={row.chainId}>
                            <dt>{row.label}</dt>
                            <dd className="mono">
                                {row.destination === null
                                    ? "no destination in this build"
                                    : `${row.destination.address} · ${row.destination.derivationPath}`}
                            </dd>
                        </Fragment>
                    ))}
                </dl>
            )}

        </div>
    );
}
