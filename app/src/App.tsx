import { useEffect, useMemo, useState } from "react";
import { createAppBindings } from "./demo/bindings.js";
import { useRecoveryFlow } from "./demo/useRecoveryFlow.js";
import { useSettlement } from "./demo/useSettlement.js";
import { useAttempts, useTimelocks, type TimelockRow } from "./demo/useTimelocks.js";
import { deriveWallet, type WalletSnapshot } from "./demo/wallet.js";
import {
    activeEntry,
    seedFingerprint,
    addGeneratedSeed,
    addImportedSeed,
    loadSeedBook,
    removeSeed,
    selectSeed,
    type SeedEntry,
} from "./demo/seeds.js";
import { DemoBanner } from "./ui/DemoBanner.js";
import { WalletCard } from "./ui/WalletCard.js";
import { WalletSwitcher } from "./ui/WalletSwitcher.js";
import { SeedBar } from "./ui/SeedBar.js";
import { SeedRemoveDialog } from "./ui/SeedRemoveDialog.js";
import { RecoverDialog } from "./ui/RecoverDialog.js";
import { RecoveryCard } from "./ui/RecoveryCard.js";
import { groupRecoveries, seedRecovery } from "./integration/recovery/recoveryCatalogue.js";
import { discardVault } from "./integration/recovery/vault.js";
import { TimelockBox } from "./ui/TimelockBox.js";
import { HandoverView } from "./ui/HandoverView.js";
import { ResetDialog } from "./ui/ResetDialog.js";
import { NetworksDialog } from "./ui/NetworksDialog.js";
import { useHandovers } from "./demo/useHandovers.js";
import { useAbort } from "./demo/useAbort.js";
import { useFeeEstimate } from "./demo/useFeeEstimate.js";
import { useChainCoverage } from "./demo/useChainCoverage.js";
import { useProtectAll } from "./demo/useProtectAll.js";
import { chainsToProtect, staleChains } from "./integration/recovery/settlement/coverage.js";
import { ProtectAllDialog } from "./ui/ProtectAllDialog.js";
import type { VaultRecord } from "./integration/recovery/vaultRecords.js";
import { Button, StatusMessage, TopBar } from "./ui/ds.js";

export function App() {
    // Built once. Rebuilding it mid-run would swap the chain registry — and, from M3, the SDK
    // instance — under whatever is using them.
    const bindings = useMemo(() => createAppBindings(), []);
    const chains = useMemo(() => bindings.chains.all(), [bindings]);

    const [activeChainId, setActiveChainId] = useState(chains[0]!.id);
    // The seed book, not `env.mnemonic`. A recovery's aftermath needs somewhere to go, and that is
    // a different account — which in a single-seed wallet means a different seed.
    const [seeds, setSeeds] = useState(loadSeedBook);
    const [removing, setRemoving] = useState<SeedEntry | null>(null);
    const mnemonic = activeEntry(seeds).mnemonic;
    // Identifies the vault, because one vault covers every chain and their accounts differ in kind.
    // A fingerprint, never the phrase: this is written into IndexedDB beside the records.
    const walletId = seedFingerprint(mnemonic);
    // Tagged with the seed it came from, and read back only when the tags match. A snapshot that
    // could be stale is a wallet rendering the previous seed's accounts as if they were this one's;
    // clearing it in an effect would fix that one render late.
    const [derived, setDerived] = useState<{ mnemonic: string; wallet: WalletSnapshot } | null>(null);
    const [failure, setFailure] = useState<{ mnemonic: string; message: string } | null>(null);
    const wallet = derived?.mnemonic === mnemonic ? derived.wallet : null;
    const error = failure?.mnemonic === mnemonic ? failure.message : null;

    useEffect(() => {
        let live = true;
        deriveWallet(bindings.chains, mnemonic)
            .then((snapshot) => live && setDerived({ mnemonic, wallet: snapshot }))
            .catch(
                (e: unknown) =>
                    live &&
                    setFailure({
                        mnemonic,
                        message: e instanceof Error ? e.message : String(e),
                    }),
            );
        return () => {
            live = false;
        };
    }, [bindings, mnemonic]);

    const chain = bindings.chains.require(activeChainId);
    const account = wallet?.accounts[chain.id]?.[0];

    // Owned here, not by the recovery card: the wallet's protection badge reads the same vault, and
    // two copies of that state would eventually disagree about whether an account is covered.
    const flow = useRecoveryFlow(bindings, bindings.methods, chain, account, walletId);

    // **Which vault is being recovered**, not merely "is the dialog open". Recovery is for the case
    // where the seed is gone, so the vault is usually not the active wallet's — reading it off the
    // chain tab is what made a lost seed's gate unreachable.
    // `null` = closed. `{vault: null}` = open with nothing chosen yet, which is what "Start
    // recovery" does — a plain `VaultRecord | null` could not tell those two apart.
    const [recovering, setRecovering] = useState<{ vault: VaultRecord | null } | null>(null);
    // Which step the dialog opens on, frozen at open time: picking a vault inside it must not
    // retroactively turn it into a dialog that never had a vault-picking step.
    const [startedWithoutVault, setStartedWithoutVault] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [showingNetworks, setShowingNetworks] = useState(false);
    const activeVault = flow.vaultFor(chain.id, walletId);

    // Keyed on the vault, not the wallet. A vault whose seed this browser can no longer derive is
    // the one that needs this screen, and it is invisible to anything keyed on the active account.
    const catalogue = useMemo(
        () =>
            groupRecoveries({
                vaults: flow.state.vaults,
                seals: flow.state.seals,
                knownWalletIds: seeds.seeds.map((entry) => seedFingerprint(entry.mnemonic)),
            }),
        [flow.state.vaults, flow.state.seals, seeds.seeds],
    );
    const chainLabels = useMemo(
        () => Object.fromEntries(chains.map((entry) => [entry.id, entry.label])),
        [chains],
    );

    // The on-chain half. Owned here for the same reason the flow is: the wallet badge and the
    // register button must never disagree about what the module holds.
    const settlement = useSettlement(bindings, chain, account, flow.vault, bindings.methods, flow.reload);


    // Every chain the vault covers, not the one on screen: a recovery is not finished until the
    // slowest timelock has matured, and the chain switcher must not change that answer.
    const timelocks = useTimelocks(bindings, flow.vault, wallet);

    // Recoveries already on-chain. Keyed on the handover rows, not on the active seed — which is
    // the seed a recovery says you no longer have, and the reason none of this was visible before.
    const handovers = useHandovers(bindings, seeds);
    // The accounts each handover row recorded — read from the chain, polled, and shared by the
    // timelock box and the handover view, so the two render the same reads. They used to disagree
    // because the handover view never asked the chain at all.
    const handoverTargets = useMemo(
        () =>
            handovers.state.groups.flatMap((group) =>
                group.records
                    .filter((record) => record.stage === "submitted")
                    .map((record) => ({
                        chainId: record.chainId,
                        accountId: record.accountId,
                        creator: record.signerAddress,
                        vaultId: record.vaultId,
                    })),
            ),
        [handovers.state.groups],
    );
    const handoverAttempts = useAttempts(bindings, wallet, handoverTargets);
    // Driven from the vault rather than from handover rows: an attempt exists on-chain whether or
    // not this browser recorded it, and a recovery somebody else opened has no row here at all.
    const aborts = useAbort(bindings, seeds);
    // Mainnet gas and token prices, read once and shared: three surfaces quote a fee.
    const fees = useFeeEstimate(bindings);

    // Every chain's balance and module state together. The recovery card is about the gate, and
    // a gate covers chains the switcher is not showing — so this is the one place that asks them
    // all rather than the active one.
    const coverage = useChainCoverage(bindings, wallet, flow.vault);
    const { targets, skipped } = useMemo(() => chainsToProtect(coverage.rows), [coverage.rows]);
    const stale = useMemo(
        () => staleChains(coverage.rows).map((row) => row.chainLabel),
        [coverage.rows],
    );
    const [protectingAll, setProtectingAll] = useState(false);
    const protectAll = useProtectAll(bindings, flow.vault, wallet, bindings.methods, async () => {
        // The ledger and every chain read are stale the moment one of these lands.
        await flow.reload();
        coverage.refresh();
        settlement.refresh();
    });
    const inFlight = handovers.state.groups.length > 0;
    const [view, setView] = useState<"wallets" | "handover">("wallets");
    // A handover that finishes while the user is elsewhere must not strand them in a view that no
    // longer exists.
    const activeView = inFlight ? view : "wallets";

    return (
        <>
            {/* `static`, and outside the shell: `fixed` expects the scroll container `<Page>` gives,
                and this app scrolls normally. */}
            <TopBar
                position="static"
                brand="NIHILIUM RECOVERY"
                links={[
                    { label: "SDK", href: "https://github.com/nihilium", external: true },
                    // Chains are named plainly everywhere else; which testnet each one uses is
                    // said once, here.
                    { label: "Public testnets", onClick: () => setShowingNetworks(true) },
                ]}
            />
            <div className="app nih-root">
                <main className="app__main">
                    <DemoBanner
                        ceremonyReady={bindings.methods !== null}
                        onReset={() => setResetting(true)}
                    />

                    {/* Above the wallets: while a recovery is running this outranks everything
                        else on the page, and it belongs to the vault rather than to any one chain. */}
                    <TimelockBox
                        // Every attempt this app is running, plus the active wallet's own chains —
                        // a recovery somebody else opened against it shows here too. One row per
                        // account, so a vault that is both is not listed twice.
                        rows={mergeAttempts(handoverAttempts.rows, timelocks.rows)}
                        // Our own record that something was submitted. Without it, a chain that
                        // simply could not be reached would raise an alarm about a recovery that
                        // does not exist.
                        expected={handoverTargets.length > 0}
                    />

                    <section className="stack" aria-label="Wallets">
                        <WalletSwitcher
                            chains={chains}
                            activeId={activeChainId}
                            vaultFor={flow.vaultFor}
                            walletId={walletId}
                            onSelect={setActiveChainId}
                        />

                        <SeedBar
                            book={seeds}
                            // Per seed, so the ones you are not looking at still say whether they
                            // are covered — which is the whole question in an emergency.
                            recoveryFor={(mnemonic) =>
                                seedRecovery({
                                    vaults: flow.state.vaults,
                                    seals: flow.state.seals,
                                    walletId: seedFingerprint(mnemonic),
                                })
                            }
                            onGenerate={() => setSeeds(addGeneratedSeed(seeds))}
                            // Throws on a bad phrase, a duplicate, or a fingerprint collision;
                            // `SeedBar` catches and shows the reason next to the field.
                            onImport={(phrase) => setSeeds(addImportedSeed(seeds, phrase))}
                            onSelect={(m) => setSeeds(selectSeed(seeds, m))}
                            onRemove={setRemoving}
                        />


                        {/* Only while something is in flight: a permanent tab for a state that
                            is almost never active is a tab that teaches the page has two halves. */}
                        {inFlight && (
                            <div className="view-switch" role="tablist" aria-label="View">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={activeView === "wallets"}
                                    className={activeView === "wallets" ? "gate-option gate-option--active" : "gate-option"}
                                    onClick={() => setView("wallets")}
                                >
                                    <span className="gate-option__title">Wallets</span>
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={activeView === "handover"}
                                    className={activeView === "handover" ? "gate-option gate-option--active" : "gate-option"}
                                    onClick={() => setView("handover")}
                                >
                                    <span className="gate-option__title">Handover</span>
                                    <span className="gate-option__gate">
                                        {handovers.state.groups.length} recover
                                        {handovers.state.groups.length === 1 ? "y" : "ies"} in flight
                                    </span>
                                </button>
                            </div>
                        )}

                        {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}

                        {activeView === "handover" && (
                            <HandoverView
                                handovers={handovers}
                                seeds={seeds}
                                chainLabels={chainLabels}
                                onGenerateSeed={() => {
                                    const next = addGeneratedSeed(seeds);
                                    setSeeds(next);
                                    return next.active;
                                }}
                                fees={fees}
                                attempts={handoverAttempts.rows}
                            />
                        )}

                        {activeView === "wallets" && (
                        <WalletCard
                            chain={chain}
                            accounts={wallet?.accounts[chain.id] ?? []}
                            failure={wallet?.failures[chain.id]}
                            vault={activeVault}
                            walletVault={flow.vault}
                            settlement={settlement}
                            onRecover={() => {
                                if (activeVault === null) return;
                                setStartedWithoutVault(false);
                                setRecovering({ vault: activeVault });
                            }}
                        />
                        )}
                    </section>

                    {activeView === "wallets" && (
                    <RecoveryCard
                        flow={flow}
                        methods={bindings.methods}
                        methodError={bindings.methodError}
                        chainLabel={chain.label}
                        onchainAttempt={settlement.state.onchain?.attempt}
                        onchainClock={settlement.state.onchain?.clock}
                        // No watchtower role exists yet. Passed as a value rather than assumed, so
                        // the day one is built this starts telling the truth without being hunted.
                        watching={false}
                        coverage={{ targets, stale }}
                        onProtectAll={() => {
                            protectAll.reset();
                            setProtectingAll(true);
                        }}
                        onOpenHandover={() => setView("handover")}
                        onAbort={() => {
                            if (flow.vault === null) return;
                            void aborts.abort(flow.vault).then(() => {
                                void handovers.reload();
                                void flow.reload();
                            });
                        }}
                        canAbort={aborts.canAbort(flow.vault)}
                        aborting={aborts.running}
                        abortLog={aborts.log}
                        account={account}
                    />
                    )}

                    {/* The way in that does not depend on which seed is active. Recovery is for a
                        seed that is gone, so the vault being opened is usually not this wallet's —
                        and every other entry point on the page is keyed on the active account,
                        which is exactly the one that cannot reach it. */}
                    {activeView === "wallets" && (
                        <div className="row">
                            <Button
                                onClick={() => {
                                    setStartedWithoutVault(true);
                                    setRecovering({ vault: null });
                                }}
                            >
                                Start recovery
                            </Button>
                        </div>
                    )}
                </main>
            </div>

            {resetting && <ResetDialog open onClose={() => setResetting(false)} />}
            {showingNetworks && (
                <NetworksDialog open onClose={() => setShowingNetworks(false)} chains={chains} />
            )}

            {/* Mounted only while open, and never moved — see `RecoveryCard` for the bug that
                rule exists to prevent. */}
            {protectingAll && (
                <ProtectAllDialog
                    key="protect-all"
                    open
                    onClose={() => setProtectingAll(false)}
                    targets={targets}
                    skipped={skipped}
                    protectAll={protectAll}
                    fees={fees}
                />
            )}

            {removing !== null && (
                <SeedRemoveDialog
                    key={removing.mnemonic}
                    seed={removing}
                    chains={bindings.chains}
                    vaults={flow.state.vaults}
                    onCancel={() => setRemoving(null)}
                    onConfirm={() => {
                        setSeeds(removeSeed(seeds, removing.mnemonic));
                        setRemoving(null);
                    }}
                />
            )}

            {recovering !== null && (
                <RecoverDialog
                    // One key for the whole opening: it unmounts on close, so state starts fresh
                    // each time — and remounting when the chosen vault changes would throw away the
                    // step the user is on.
                    key="recover-dialog"
                    open
                    onClose={() => {
                        setRecovering(null);
                        // A recovery writes handover rows, and this hook only reads them on mount.
                        // Without this the switcher that leads to them does not appear until a
                        // reload — so the screen that says what to do next is unreachable from the
                        // screen that just created the need for it.
                        void handovers.reload();
                        void flow.reload();
                    }}
                    flow={flow}
                    vault={recovering.vault}
                    onChooseVault={(chosen) => setRecovering({ vault: chosen })}
                    startAtVaultStep={startedWithoutVault}
                    catalogue={catalogue}
                    chainLabels={chainLabels}
                    seeds={seeds}
                    onGenerateSeed={() => {
                        const next = addGeneratedSeed(seeds);
                        setSeeds(next);
                        return next.active;
                    }}
                    onImportSeal={async (file) => {
                        await flow.importSeal(await file.text());
                    }}
                    onDelete={(row) => {
                        void discardVault(bindings.stores, row.vault.vaultId).then(flow.reload);
                    }}
                    onOpenHandover={() => {
                        setRecovering(null);
                        void handovers.reload();
                        void flow.reload();
                        setView("handover");
                    }}
                    fees={fees}
                />
            )}
        </>
    );
}

/** One row per account. The handover's read wins: it is the one a user is acting on. */
function mergeAttempts(
    first: readonly TimelockRow[],
    second: readonly TimelockRow[],
): readonly TimelockRow[] {
    const key = (row: TimelockRow) => `${row.vaultId}:${row.chainId}:${row.accountId}`;
    const seen = new Set(first.map(key));
    return [...first, ...second.filter((row) => !seen.has(key(row)))];
}
