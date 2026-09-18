/**
 * One chain's accounts. Plural everywhere, because a UTXO chain has several and a component that
 * assumed one would be a component that special-cases Zcash later.
 */
import type { Balance, ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { useBalances } from "../demo/useBalances.js";
import { AddressChip } from "./AddressChip.js";
import { Explain } from "./Explain.js";
import { ProtectionBadge } from "./ProtectionBadge.js";
import { protectionOf } from "./protection.js";
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
    vault,
    onRecover,
}: {
    chain: ChainModule;
    accounts: DerivedAccount[];
    failure: string | undefined;
    /** The vault covering this chain, or null. Drives the badge, and nothing else here. */
    vault: VaultRecord | null;
    /**
     * Starts a recovery. It belongs on the wallet rather than beside the gate: losing access is
     * something that happens to a wallet, and this is where a user looks when it has.
     */
    onRecover: () => void;
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
                <div className="card-head">
                    <Heading level={3}>{chain.label}</Heading>
                    <ProtectionBadge state={protectionOf(vault, chain.id)} />
                </div>

                <Explain>
                    <p className="mono">
                        {chain.namespace} · tier {chain.tier} · {chain.keyAdapter.algorithm}
                    </p>
                    <p>
                        The namespace and the tier are KDF inputs, pinned at seal time and never
                        recomputed from the registry. The tier decides which veto capabilities exist at
                        all.
                    </p>
                </Explain>

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

                {vault !== null && vault.spent === null && (
                    <div className="card-foot">
                        <button type="button" className="linkish" onClick={onRecover}>
                            Lost access to this wallet?
                        </button>
                    </div>
                )}

                {chain.settlement === null && (
                    <Explain>
                        <p>
                            No settlement binding yet: a recovery key derived for this chain is
                            registered nowhere, so it protects nothing. That half arrives with the
                            on-chain milestone — and on{" "}
                            {chain.tier === "script" ? "this chain" : "Solana"} it stays simulated.
                        </p>
                    </Explain>
                )}
            </div>
        </Card>
    );
}
