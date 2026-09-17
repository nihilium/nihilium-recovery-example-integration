import { useEffect, useMemo, useState } from "react";
import { createAppBindings } from "./demo/bindings.js";
import { deriveWallet, type WalletSnapshot } from "./demo/wallet.js";
import { DemoBanner } from "./ui/DemoBanner.js";
import { WalletCard } from "./ui/WalletCard.js";
import { WalletSwitcher } from "./ui/WalletSwitcher.js";
import { Card, Heading, StatusMessage, TopBar } from "./ui/ds.js";

export function App() {
    // Built once. Rebuilding it mid-run would swap the chain registry — and, from M3, the SDK
    // instance — under whatever is using them.
    const bindings = useMemo(() => createAppBindings(), []);
    const chains = useMemo(() => bindings.chains.all(), [bindings]);

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

    return (
        <>
            {/* `static`, and outside the shell: `fixed` expects the scroll container `<Page>` gives,
                and this app scrolls normally. */}
            <TopBar
                position="static"
                brand="NIHILIUM RECOVERY"
                links={[
                    { label: "SDK", href: "https://github.com/nihilium", external: true },
                    { label: "CLAUDE.md", href: "https://github.com/nihilium", external: true },
                ]}
            />
            <div className="app nih-root">
                <main className="app__main">
                    <DemoBanner mode={bindings.env.mode} />

                    <section className="stack" aria-label="Wallets">
                        <Heading level={2}>Wallets</Heading>
                        <p className="muted">
                            One 12-word seed phrase, every chain derived from it. Switching here
                            changes which chain the scenarios below act on.
                        </p>
                        <p className="mono muted">{bindings.env.mnemonic}</p>

                        <WalletSwitcher
                            chains={chains}
                            activeId={activeChainId}
                            onSelect={setActiveChainId}
                        />

                        {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}

                        <WalletCard
                            chain={chain}
                            accounts={wallet?.accounts[chain.id] ?? []}
                            failure={wallet?.failures[chain.id]}
                        />
                    </section>

                    <section className="stack" aria-label="Scenarios">
                        <Heading level={2}>Recovery scenarios</Heading>
                        <Card padding="md">
                            <p className="muted">
                                The scenario runner arrives next. Each scenario answers one question,
                                names the roles it involves, and logs every SDK call it makes.
                            </p>
                        </Card>
                    </section>
                </main>
            </div>
        </>
    );
}
