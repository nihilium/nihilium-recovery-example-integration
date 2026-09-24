/**
 * Which network each chain runs on, in one place.
 *
 * The rest of the page names chains the way a user would — Ethereum, Solana, Zcash — so the testnet
 * each one talks to is said here, once, behind the "Public testnets" button, rather than repeated in
 * every label as "EVM · Sepolia" and "Solana · devnet".
 */
import { Fragment } from "react";
import type { ChainModule } from "../integration/chains/types.js";
import { Button } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";

export function NetworksDialog({
    open,
    onClose,
    chains,
}: {
    open: boolean;
    onClose: () => void;
    chains: readonly ChainModule[];
}) {
    return (
        <Dialog
            open={open}
            title="Public testnets"
            onClose={onClose}
            footer={
                <DialogActions>
                    <Button onClick={onClose}>Close</Button>
                </DialogActions>
            }
        >
            <dl className="rows">
                {chains.map((chain) => (
                    <Fragment key={chain.id}>
                        <dt>{chain.label}</dt>
                        <dd>{chain.network}</dd>
                    </Fragment>
                ))}
            </dl>
        </Dialog>
    );
}
