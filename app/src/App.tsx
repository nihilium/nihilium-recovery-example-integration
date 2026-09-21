import { useEffect, useMemo, useState } from "react";
import { createAppBindings } from "./demo/bindings.js";
import { useRecoveryFlow } from "./demo/useRecoveryFlow.js";
import { useRecoveryChain } from "./demo/useRecoveryChain.js";
import { useSettlement } from "./demo/useSettlement.js";
import { deriveWallet, type WalletSnapshot } from "./demo/wallet.js";
import { DemoBanner } from "./ui/DemoBanner.js";
import { Explain, ExplainProvider } from "./ui/Explain.js";
import { useExplain } from "./ui/explainContext.js";
import { WalletCard } from "./ui/WalletCard.js";
import { WalletSwitcher } from "./ui/WalletSwitcher.js";
import { RecoverDialog } from "./ui/RecoverDialog.js";
import { RecoveryCard } from "./ui/RecoveryCard.js";
import { protectionOf } from "./ui/protection.js";
import { StatusMessage, TopBar } from "./ui/ds.js";

export function App() {
    return (
        <ExplainProvider>
            <Shell />
        </ExplainProvider>
    );
}

function Shell() {
    // Built once. Rebuilding it mid-run would swap the chain registry — and, from M3, the SDK
    // instance — under whatever is using them.
    const bindings = useMemo(() => createAppBindings(), []);
    const chains = useMemo(() => bindings.chains.all(), [bindings]);
    const explain = useExplain();

    const [activeChainId, setActiveChainId] = useState(chains[0]!.id);
    const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        deriveWallet(bindings.chains, bindings.env.mnemonic)
            .then((snapshot) => live && setWallet(snapshot))
            .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
        return () => {
            live = false;
        };
    }, [bindings]);

    const chain = bindings.chains.require(activeChainId);
    const account = wallet?.accounts[chain.id]?.[0];

    // Owned here, not by the recovery card: the wallet's protection badge reads the same vault, and
    // two copies of that state would eventually disagree about whether an account is covered.
    const flow = useRecoveryFlow(bindings, bindings.methods, chain, account);

    // Opened from the wallet card and rendered here, because the thing it acts on is the vault this
    // component owns rather than anything either card holds.
    const [recovering, setRecovering] = useState(false);
    const activeVault = flow.vaultFor(chain.id);

    // The on-chain half. Owned here for the same reason the flow is: the wallet badge and the
    // register button must never disagree about what the module holds.
    const settlement = useSettlement(bindings, chain, account, activeVault);

    // The on-chain half of a recovery. Its own hook because it fails on its own: a vault can be open
    // with nothing ever submitted, and that is a state, not an error.
    const onchainRecovery = useRecoveryChain(bindings, chain, activeVault);

    return (
        <>
            {/* `static`, and outside the shell: `fixed` expects the scroll container `<Page>` gives,
                and this app scrolls normally. */}
            <TopBar
                position="static"
                brand="NIHILIUM RECOVERY"
                links={[
                    { label: explain.on ? "Explain: on" : "Explain: off", onClick: explain.toggle },
                    { label: "SDK", href: "https://github.com/nihilium", external: true },
                ]}
            />
            <div className="app nih-root">
                <main className="app__main">
                    <DemoBanner ceremonyReady={bindings.methods !== null} />

                    <section className="stack" aria-label="Wallets">
                        <WalletSwitcher
                            chains={chains}
                            activeId={activeChainId}
                            vaultFor={flow.vaultFor}
                            onSelect={setActiveChainId}
                        />

                        <p className="mono muted">{bindings.env.mnemonic}</p>

                        <Explain>
                            <p>
                                One 12-word seed phrase, every chain derived from it, printed in the open
                                because the point of this demo is to lose it convincingly. Switching
                                above changes which chain the card below acts on.
                            </p>
                        </Explain>

                        {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}

                        <WalletCard
                            chain={chain}
                            accounts={wallet?.accounts[chain.id] ?? []}
                            failure={wallet?.failures[chain.id]}
                            vault={activeVault}
                            settlement={settlement}
                            onRecover={() => setRecovering(true)}
                        />
                    </section>

                    <RecoveryCard
                        flow={flow}
                        methods={bindings.methods}
                        methodError={bindings.methodError}
                        chainLabel={chain.label}
                        onchainAttempt={settlement.state.onchain?.attempt}
                        // No watchtower role exists yet. Passed as a value rather than assumed, so
                        // the day one is built this starts telling the truth without being hunted.
                        watching={false}
                        protection={protectionOf(activeVault, chain.id, settlement.state.onchain)}
                        protecting={settlement.state.phase === "protecting"}
                        onProtect={() => void settlement.protect()}
                        account={account}
                    />
                </main>
            </div>

            {recovering && activeVault !== null && (
                <RecoverDialog
                    open={recovering}
                    onClose={() => setRecovering(false)}
                    flow={flow}
                    vault={activeVault}
                    chain={chain}
                    suggestedTarget={wallet?.recoveryTarget}
                    onchain={onchainRecovery}
                />
            )}
        </>
    );
}
