/**
 * Moving value out of the smart account.
 *
 * It exists so the demo can demonstrate that the account is a real account — one that holds funds
 * and spends them — rather than an address that only ever receives. It is also what makes a recovery
 * mean something: an account you cannot spend from is one nobody needs to recover.
 *
 * Nothing here knows what a UserOp is. The amount is in base units, the chain's own
 * `send` capability does the work, and a chain that has not wired one renders no button at all.
 */
import { useState } from "react";
import {
    formatAmount,
    parseAmount,
    subtractReserve,
} from "../integration/chains/amounts.js";
import type { Balance, ChainModule, DerivedAccount } from "../integration/chains/types.js";
import { Button, StatusMessage, TextInput, TextLink } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Transcript } from "./Transcript.js";
import { Explain } from "./Explain.js";

export function SendDialog({
    open,
    onClose,
    chain,
    account,
    balance,
}: {
    open: boolean;
    onClose: () => void;
    chain: ChainModule;
    account: DerivedAccount;
    balance: Balance | null;
}) {
    const send = chain.send!;
    const [to, setTo] = useState("");
    const [amount, setAmount] = useState("");
    const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
    const [log, setLog] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [hash, setHash] = useState<string | null>(null);

    const decimals = balance?.decimals ?? 18;
    const symbol = balance?.symbol ?? "";
    // The whole balance is never sendable: this account pays its own fee out of it.
    const sendable = balance === null ? 0n : subtractReserve(balance.raw, send.reserve());
    const parsed = parseAmount(amount, decimals);

    const tooMuch = parsed !== null && parsed > sendable;
    // The chain's own answer, never a pattern here. A shared `/^0x…{40}$/` meant the Send button
    // could not enable on any chain but EVM — see `ChainModule.isValidAddress`.
    const destinationOk = chain.isValidAddress(to);
    const valid = destinationOk && parsed !== null && parsed > 0n && !tooMuch;

    async function submit(): Promise<void> {
        setPhase("sending");
        setError(null);
        setLog([]);
        try {
            const receipt = await send.send({
                from: account,
                to: to.trim(),
                amount: parsed!,
                onProgress: (line) => setLog((prev) => [...prev, line]),
            });
            setHash(receipt.hash);
            setPhase("sent");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase("idle");
        }
    }

    return (
        <Dialog
            open={open}
            title={`Send from ${chain.label}`}
            onClose={onClose}
            // A transfer in flight has been handed to a bundler and cannot be recalled.
            dismissible={phase !== "sending"}
            footer={
                phase === "sent" ? (
                    <DialogActions>
                        <Button onClick={onClose}>Done</Button>
                    </DialogActions>
                ) : (
                    <DialogActions>
                        <Button onClick={() => void submit()} disabled={!valid || phase === "sending"}>
                            {phase === "sending" ? "Sending…" : "Send"}
                        </Button>
                    </DialogActions>
                )
            }
        >
            <div className="stack">
                <div className="field">
                    <label className="field__labelled">
                        <span className="field__label">To</span>
                        <TextInput
                            value={to}
                            ariaLabel="Recipient address"
                            placeholder={chain.id === "evm-sepolia" ? "0x…" : "address"}
                            onChange={(event) => setTo(event.target.value)}
                            disabled={phase !== "idle"}
                        />
                    </label>
                    {to.trim() !== "" && !destinationOk && (
                        <span className="muted">Not a {chain.label} address.</span>
                    )}
                </div>

                <div className="field">
                    <label className="field__labelled">
                        <span className="field__label">Amount</span>
                        <TextInput
                            value={amount}
                            ariaLabel="Amount"
                            placeholder="0.0"
                            onChange={(event) => setAmount(event.target.value)}
                            disabled={phase !== "idle"}
                        />
                    </label>
                    <span className="row">
                        <span className="muted">
                            {formatAmount(sendable, decimals)} {symbol} sendable
                        </span>
                        <button
                            type="button"
                            className="linkish"
                            onClick={() => setAmount(formatAmount(sendable, decimals))}
                            disabled={phase !== "idle"}
                        >
                            Max
                        </button>
                    </span>
                </div>

                {tooMuch && (
                    <StatusMessage tone="error">
                        That is more than this account can send. It pays its own fee out of the same
                        balance, so {formatAmount(send.reserve(), decimals)} {symbol} stays behind.
                    </StatusMessage>
                )}

                <Transcript lines={log} running={phase === "sending"} label="Sending" />

                {hash !== null && (
                    <StatusMessage tone="success">
                        Sent.{" "}
                        <TextLink href={chain.explorerUrl({ kind: "tx", value: hash }) ?? "#"} external>
                            View the transaction
                        </TextLink>
                    </StatusMessage>
                )}

                {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}

                <Explain>
                    <p>
                        This is a UserOperation, not a transaction: the smart account asks the entry
                        point to run one call on its behalf, and the wallet&apos;s key signs that
                        request rather than the transfer. Nothing here pays a paymaster, so the
                        account funds its own execution — which is why the full balance is never
                        sendable.
                    </p>
                </Explain>
            </div>
        </Dialog>
    );
}
