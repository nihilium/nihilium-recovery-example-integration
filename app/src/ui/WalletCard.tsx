/**
 * One chain's accounts. Plural everywhere, because a UTXO chain has several and a component that
 * assumed one would be a component that special-cases Zcash later.
 */
import type { Balance, ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { useState } from "react";
import { formatAmount } from "../integration/chains/amounts.js";
import { useBalances } from "../demo/useBalances.js";
import { AddressChip } from "./AddressChip.js";
import { Explain } from "./Explain.js";
import { ProtectionBadge } from "./ProtectionBadge.js";
import type { Settlement } from "../demo/useSettlement.js";
import { protectionOf } from "./protection.js";
import { SendDialog } from "./SendDialog.js";
import { SimulatedBadge } from "./SimulatedBadge.js";
import { Button, Card, Heading, StatusMessage, TextLink } from "./ds.js";

/** One formatter for the whole app, in `integration/chains/amounts.ts`. */
function showBalance(balance: Balance): string {
    return `${formatAmount(balance.raw, balance.decimals)} ${balance.symbol}`;
}

export function WalletCard({
    chain,
    accounts,
    failure,
    vault,
    settlement,
    onRecover,
}: {
    chain: ChainModule;
    accounts: DerivedAccount[];
    failure: string | undefined;
    /** The vault covering this chain, or null. Drives the badge, and nothing else here. */
    vault: VaultRecord | null;
    /** The on-chain half: what the module holds, and the action that puts it there. */
    settlement: Settlement;
    /**
     * Starts a recovery. It belongs on the wallet rather than beside the gate: losing access is
     * something that happens to a wallet, and this is where a user looks when it has.
     */
    onRecover: () => void;
}) {
    const balances = useBalances(chain, accounts);
    const [sending, setSending] = useState(false);
    const first = accounts[0];
    const firstBalance = first === undefined ? undefined : balances[first.address];
    // Read from the chain when it has been read; "not asked yet" is deliberately not "not installed".
    const state = protectionOf(vault, chain.id, settlement.state.onchain);

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
                    <ProtectionBadge state={state} />
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
                                      : showBalance(balance)}
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

                {/* The on-chain half, where the badge above says it is missing. Sealing produces a
                    recovery key; until the module holds it, nothing on this chain would honour it. */}
                {vault !== null && vault.spent === null && settlement.supported && (
                    <div className="stack">
                        {(state === "sealed" || state === "stale") && (
                            <div className="row">
                                <Button
                                    onClick={() => void settlement.protect()}
                                    disabled={settlement.state.phase === "protecting"}
                                >
                                    {settlement.state.phase === "protecting"
                                        ? "Sending…"
                                        : state === "stale"
                                          ? "Finish the rotation"
                                          : "Protect this account"}
                                </Button>
                                <span className="muted">
                                    {state === "stale"
                                        ? "The chain holds a key from a gate you replaced."
                                        : "Registers this vault's recovery key on-chain. Costs gas, paid by this account."}
                                </span>
                            </div>
                        )}

                        {settlement.state.log.length > 0 && (
                            <pre className="transcript">{settlement.state.log.join("\n")}</pre>
                        )}

                        {settlement.state.txHash !== null && (
                            <StatusMessage tone="success">
                                Registered on-chain.{" "}
                                <TextLink
                                    href={
                                        chain.explorerUrl({
                                            kind: "tx",
                                            value: settlement.state.txHash,
                                        }) ?? "#"
                                    }
                                    external
                                >
                                    View the transaction
                                </TextLink>
                            </StatusMessage>
                        )}

                        {settlement.state.error !== null && (
                            <StatusMessage tone="error">{settlement.state.error}</StatusMessage>
                        )}

                        <Explain>
                            <p>
                                Only an account can install its own module, so this is a UserOp signed
                                by the wallet&apos;s own key and paid for by the account — the relayer
                                cannot do it. That is the opposite of the recovery itself, where the
                                authority is the signature and anyone with gas may send it.
                            </p>
                        </Explain>
                    </div>
                )}

                <div className="card-foot">
                    {chain.send !== null && first !== undefined ? (
                        <Button variant="ghost" onClick={() => setSending(true)}>
                            Send
                        </Button>
                    ) : (
                        <span className="muted">No transfer wired for this chain.</span>
                    )}
                    {vault !== null && vault.spent === null && (
                        <button type="button" className="linkish" onClick={onRecover}>
                            Lost access to this wallet?
                        </button>
                    )}
                </div>

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

            {/* Mounted only while open, and never moved — see `RecoveryCard` for the bug that rule
                exists to prevent. */}
            {sending && first !== undefined && chain.send !== null && (
                <SendDialog
                    key="send-dialog"
                    open={sending}
                    onClose={() => setSending(false)}
                    chain={chain}
                    account={first}
                    balance={typeof firstBalance === "object" ? firstBalance : null}
                />
            )}
        </Card>
    );
}
