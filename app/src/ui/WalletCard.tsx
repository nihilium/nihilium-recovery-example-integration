/**
 * One chain's accounts. Plural everywhere, because a UTXO chain has several and a component that
 * assumed one would be a component that special-cases Zcash later.
 */
import type { Balance, ChainModule, DerivedAccount } from "../integration/chains/types.js";
import { useBalances } from "../demo/useBalances.js";
import { AddressChip } from "./AddressChip.js";
import { SimulatedBadge } from "./SimulatedBadge.js";
import { Card, Heading, StatusMessage, TextLink } from "./ds.js";

function formatAmount(balance: Balance): string {
    const whole = balance.raw / 10n ** BigInt(balance.decimals);
    const fraction = balance.raw % 10n ** BigInt(balance.decimals);
    const decimals = fraction === 0n ? "" : `.${fraction.toString().padStart(balance.decimals, "0").replace(/0+$/, "")}`;
    return `${whole}${decimals} ${balance.symbol}`;
}

export function WalletCard({
    chain,
    accounts,
    failure,
}: {
    chain: ChainModule;
    accounts: DerivedAccount[];
    failure: string | undefined;
}) {
    const balances = useBalances(chain, accounts);

    if (failure !== undefined) {
        return (
            <Card padding="md">
                <StatusMessage tone="error">
                    {chain.label} could not derive its accounts: {failure}
                </StatusMessage>
            </Card>
        );
    }

    return (
        <Card padding="md">
            <div className="stack">
                <div className="row">
                    <Heading level={3}>{chain.label}</Heading>
                    <span className="muted mono">{chain.namespace}</span>
                    <span className="muted">tier: {chain.tier}</span>
                    <span className="muted">curve: {chain.keyAdapter.algorithm}</span>
                </div>

                {accounts.length === 0 && <p className="muted">Deriving…</p>}

                {accounts.map((account) => {
                    const balance = balances[account.address];
                    const explorer = chain.explorerUrl({ kind: "address", value: account.address });
                    return (
                        <div className="account-row" key={account.address}>
                            <div className="account-row__labels">
                                <span>{account.label}</span>
                                <span className="muted mono">{account.derivationPath}</span>
                            </div>
                            <AddressChip
                                value={account.address}
                                display={chain.formatAddress(account.address, "short")}
                            />
                            <span className="account-row__balance mono">
                                {balance === undefined || balance === "loading"
                                    ? "…"
                                    : balance === "unreadable"
                                      ? "balance unreadable"
                                      : formatAmount(balance)}
                                {typeof balance === "object" && balance.source === "simulated" && (
                                    <SimulatedBadge reason="no node is queried for this chain" />
                                )}
                            </span>
                            {explorer !== null && (
                                <TextLink href={explorer} external>
                                    explorer
                                </TextLink>
                            )}
                        </div>
                    );
                })}

                {chain.settlement === null && (
                    <p className="muted">
                        No settlement binding yet: a recovery key derived for this chain is
                        registered nowhere, so it protects nothing. That half arrives with the
                        on-chain milestone — and on {chain.tier === "script" ? "this chain" : "Solana"} it
                        stays simulated.
                    </p>
                )}
            </div>
        </Card>
    );
}
