/**
 * Removing a seed — which, for a generated one, is the loss this demo exists to stage.
 *
 * A generated seed lives in one place: this browser. Removing it destroys the only copy and the
 * wallet's own signing key with it. That is not a destructive action to be talked out of, it is the
 * event recovery answers — so the dialog's job is to say *which* of two very different things is
 * about to happen:
 *
 * - **The account has a gate.** This is a staged loss. The vault survives, because a recovery needs
 *   the seal and the guardians and never the wallet seed, and the chain context it needs is in the
 *   ledger row. You can recover the account afterwards.
 * - **The account has no gate.** Nothing survives. Anything at those addresses is unreachable, by
 *   exactly the mechanism recovery exists to prevent.
 *
 * It derives the seed's accounts on open rather than trusting a label, because the answer depends on
 * what is actually in the vault store for those accounts — and on EVM that address needs a network
 * round trip to learn.
 */
import { useEffect, useState } from "react";
import type { ChainRegistry } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { deriveWallet } from "../demo/wallet.js";
import type { SeedEntry } from "../demo/seeds.js";
import { AddressChip } from "./AddressChip.js";
import { Button, StatusMessage } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Notice } from "./Notice.js";

interface Covered {
    /** Chain labels whose account for this seed has a vault. */
    protectedChains: string[];
    /** Chain labels whose account has none. */
    bareChains: string[];
}

export function SeedRemoveDialog({
    seed,
    chains,
    vaults,
    onCancel,
    onConfirm,
}: {
    seed: SeedEntry;
    chains: ChainRegistry;
    vaults: readonly VaultRecord[];
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const [covered, setCovered] = useState<Covered | null>(null);
    const [failed, setFailed] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void deriveWallet(chains, seed.mnemonic)
            .then((wallet) => {
                if (!live) return;
                const protectedChains: string[] = [];
                const bareChains: string[] = [];
                for (const chain of chains.all()) {
                    const accountId = wallet.accounts[chain.id]?.[0]?.accountId;
                    if (accountId === undefined) continue;
                    const held = vaults.some((vault) =>
                        vault.chains.some((row) => row.accountId === accountId),
                    );
                    (held ? protectedChains : bareChains).push(chain.label);
                }
                setCovered({ protectedChains, bareChains });
            })
            .catch((error: unknown) => {
                if (!live) return;
                // An unreadable answer is not a safe one: without knowing which accounts have gates,
                // the dialog cannot say what removing this seed costs, and says so.
                setFailed(error instanceof Error ? error.message : String(error));
            });
        return () => {
            live = false;
        };
    }, [chains, seed.mnemonic, vaults]);

    const checking = covered === null && failed === null;

    return (
        <Dialog
            open
            title={`Remove ${seed.label}`}
            onClose={onCancel}
            footer={
                <DialogActions back={{ label: "Keep it", onClick: onCancel }}>
                    <Button onClick={onConfirm} disabled={checking}>
                        {checking ? "Checking…" : "Forget this seed"}
                    </Button>
                </DialogActions>
            }
        >
            <div className="stack">
                <p>
                    This is the only copy. Removing it is permanent.
                </p>

                <div className="row">
                    <span className="field__label">Copy it first</span>
                    <AddressChip value={seed.mnemonic} display={seed.mnemonic} />
                </div>

                {checking && <p className="muted">Checking what these accounts hold…</p>}

                {failed !== null && (
                    <StatusMessage tone="error">
                        Could not derive this seed&apos;s accounts, so what removing it costs is
                        unknown: {failed}
                    </StatusMessage>
                )}

                {covered !== null && covered.protectedChains.length > 0 && (
                    <Notice>
                        <strong>{covered.protectedChains.join(", ")}</strong> — recoverable
                        without this seed.
                    </Notice>
                )}

                {covered !== null && covered.bareChains.length > 0 && (
                    <Notice tone="caution">
                        <strong>{covered.bareChains.join(", ")}</strong> — no recovery.
                        Funds here become unreachable.
                    </Notice>
                )}

            </div>
        </Dialog>
    );
}
