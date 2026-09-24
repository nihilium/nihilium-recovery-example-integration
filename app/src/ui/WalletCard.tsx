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
import { Transcript } from "./Transcript.js";
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
    walletVault,
    settlement,
    onRecover,
}: {
    chain: ChainModule;
    accounts: DerivedAccount[];
    failure: string | undefined;
    /** The vault covering *this chain*, or null. Drives the badge, and the protect action. */
    vault: VaultRecord | null;
    /**
     * The vault this wallet holds at all, covering whichever chains `addChain()` has reached.
     *
     * Separate from `vault` because the two answer different questions, and the gap between them is
     * the state this card most needs to render: a wallet with a perfectly good gate, on a chain
     * that gate does not cover yet. Before this was here, that state showed as *nothing* — no
     * badge action, no protect button — while the chain it was sealed from showed a full set, and
     * the one action that fixes it sat inside a collapsed card further down the page.
     */
    walletVault: VaultRecord | null;
    /** The on-chain half: what the module holds, and the action that puts it there. */
    settlement: Settlement;
    /**
     * Starts a recovery. It belongs on the wallet rather than beside the gate: losing access is
     * something that happens to a wallet, and this is where a user looks when it has.
     */
    onRecover: () => void;
}) {

    const balances = useBalances(chain, accounts.map((a) => a.address));
    const [sending, setSending] = useState(false);
    const first = accounts[0];
    // `accounts[0]` is the account on every chain now — the smart account on EVM, the vault on
    // Solana — so what it holds is what a send spends. There is no signer-versus-account split
    // left to get wrong.
    const firstBalance = first === undefined ? undefined : balances[first.address];
    const sendableBalance = typeof firstBalance === "object" ? firstBalance : null;
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


                {accounts.length === 0 && <p className="muted">Deriving…</p>}

                {accounts.map((account) => {
                    const balance = balances[account.address];
                    /**
                     * The account recovery protects, and where its value is sent, are not always
                     * the same address. On EVM both are the Safe. On Solana the smart account is a
                     * program-owned vault (`accountId`) and its SOL sits in a separate keyless PDA
                     * that only the program can pay out of — so showing that alone, with an
                     * explorer link that calls it a "System Account", made a recoverable vault look
                     * like a plain wallet. Both are shown, each named for what it is. The deposit
                     * address stays the one to send to: SOL sent to the vault itself is stranded,
                     * since `execute_transfer` only pays out of the deposit account.
                     */
                    const split = account.accountId !== undefined && account.accountId !== account.address;
                    const identity = split ? account.accountId! : account.address;
                    const explorer = chain.explorerUrl({ kind: "address", value: identity });
                    return (
                        <div className="account-row" key={account.address}>
                            <div className="account-row__labels">
                                <span>{account.label}</span>
                                <span className="muted mono">{account.derivationPath}</span>
                            </div>
                            <AddressChip
                                value={identity}
                                display={chain.formatAddress(identity, "short")}
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
                            {split && (
                                <div className="account-row__deposit">
                                    <span className="muted">deposit address</span>
                                    <AddressChip
                                        value={account.address}
                                        display={chain.formatAddress(account.address, "short")}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}


                {/* One vault, every chain. A gate exists but has never been extended to this chain,
                    so the honest next step is not a second ceremony — it is `addChain()`, which is
                    free, local, and contacts nobody. Offered here rather than only in the recovery
                    card, because that card is collapsed by default and this is the action that
                    makes one seal cover both chains. */}
                {/* One action, on every chain. A chain the gate has not reached yet is added as
                    part of protecting it rather than by a separate button pressed first: the add is
                    free and instant, and making it a step of its own made it read as a cost. */}
                {vault === null && walletVault !== null && walletVault.spent === null && (
                    <div className="row">
                        <Button
                            onClick={() => void settlement.protect()}
                            disabled={settlement.state.phase === "protecting"}
                        >
                            {settlement.state.phase === "protecting"
                                ? "Protecting…"
                                : "Protect this account"}
                        </Button>
                    </div>
                )}

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
                            </div>
                        )}

                        {settlement.state.log.length > 0 && (
                            <Transcript
                                lines={settlement.state.log}
                                running={settlement.state.phase === "protecting"}
                                label="Protecting"
                            />
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
                    // **The account the value leaves**, which is not always the one that signs.
                    // Solana's `send` is `execute_transfer` and spends the vault; taking the
                    // signer's balance here capped the amount at the owner key's lamports and
                    // offered to send funds that account does not hold.
                    balance={sendableBalance}
                />
            )}
        </Card>
    );
}
