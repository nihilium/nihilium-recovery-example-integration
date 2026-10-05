/**
 * Starting over, with what it costs said first.
 *
 * A `Dialog` because it is irreversible, and irreversible things do not happen on a page in this
 * app. The copy names what is destroyed and — as importantly — what is not: resetting the browser
 * does not move anything on-chain, and a user who read "reset" as "undo" would be wrong in the
 * direction that loses funds.
 *
 * **Seeds by default, everything on request.** The default keeps the seals and records, so "lose the
 * seed, then recover" needs no file. "Also delete seals and records" is the full wipe. See
 * `demo/reset.ts`.
 *
 * **What it checks first.** Every seed whose accounts still hold something is listed with its phrase
 * one click from the clipboard, and whether anything but that phrase could reach the account
 * afterwards. A seed sealed but never protected on-chain looks safe and is not — a recovery opens its
 * vault and the chain accepts nothing — so this is where that gets said, while the phrase still exists.
 */
import { useEffect, useState } from "react";
import { resetDemo } from "../demo/reset.js";
import type { AppBindings } from "../demo/bindings.js";
import type { SeedEntry } from "../demo/seeds.js";
import { readSeedRisks, type AccountReach, type SeedAtRisk } from "../demo/seedRisks.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { formatAmount } from "../integration/chains/amounts.js";
import { AddressChip } from "./AddressChip.js";
import { Button, Checkbox, StatusMessage } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Notice } from "./Notice.js";

function reachLabel(reach: AccountReach, keepRecovery: boolean): string {
    if (reach === "protected") {
        return keepRecovery
            ? "protected on-chain — recoverable from this browser"
            : "protected on-chain — recoverable only with its seal file";
    }
    return reach === "phrase-only"
        ? "not protected on-chain — only the phrase reaches it"
        : "protection could not be checked";
}

export function ResetDialog({
    open,
    onClose,
    bindings,
    seeds,
    vaults,
}: {
    open: boolean;
    onClose: () => void;
    bindings: AppBindings;
    seeds: readonly SeedEntry[];
    vaults: readonly VaultRecord[];
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Read once, when the dialog opens: it is mounted only while open, so this is the moment the
    // question is being asked.
    const [risks, setRisks] = useState<SeedAtRisk[] | null>(null);
    const [riskError, setRiskError] = useState<string | null>(null);
    const [accepted, setAccepted] = useState(false);
    // Off by default: losing the seed and recovering is the demo, and the seal stands in for the
    // copy a real user keeps off the device. Wiping it too is the "start from nothing" reset.
    const [wipeRecovery, setWipeRecovery] = useState(false);

    useEffect(() => {
        let live = true;
        readSeedRisks(bindings, seeds, vaults).then(
            (rows) => live && setRisks(rows),
            (failure: unknown) =>
                live && setRiskError(failure instanceof Error ? failure.message : String(failure)),
        );
        return () => {
            live = false;
        };
    }, [bindings, seeds, vaults]);

    const checking = risks === null && riskError === null;
    // Anything listed, or a check that failed, has to be acknowledged: an unread balance is not a
    // zero one.
    const mustAccept = riskError !== null || (risks !== null && risks.length > 0);

    async function run(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await resetDemo({ keepRecovery: !wipeRecovery });
            // Reloaded rather than re-rendered: every hook here holds state derived from the two
            // stores that no longer exist, and reconciling that in place is a lot of code for a
            // path whose whole point is that nothing is worth keeping.
            window.location.reload();
        } catch (failure) {
            setBusy(false);
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }

    return (
        <Dialog
            open={open}
            title="Reset this demo"
            onClose={onClose}
            dismissible={!busy}
            footer={
                <DialogActions back={{ label: "Cancel", onClick: onClose, disabled: busy }}>
                    <Button
                        onClick={() => void run()}
                        disabled={busy || checking || (mustAccept && !accepted)}
                    >
                        {busy
                            ? "Clearing…"
                            : checking
                              ? "Checking the seeds…"
                              : wipeRecovery
                                ? "Delete everything"
                                : "Reset the wallet"}
                    </Button>
                </DialogActions>
            }
        >
            <div className="stack">
                <Notice tone="caution">
                    {wipeRecovery
                        ? "Deletes every seed, seal, record and handover in this browser. Download seal files first — they exist nowhere else."
                        : "Deletes every seed and handover in this browser. Seals and records stay, so recovering needs no file."}
                </Notice>
                <Checkbox
                    label="Also delete seals and records"
                    checked={wipeRecovery}
                    onChange={(event) => setWipeRecovery(event.target.checked)}
                />
                <p>On-chain accounts and pending recoveries are unaffected.</p>

                {checking && <p className="muted">Checking what each seed still holds…</p>}

                {riskError !== null && (
                    <StatusMessage tone="error">
                        Could not check the seeds&apos; balances: {riskError}
                    </StatusMessage>
                )}

                {risks !== null && risks.length > 0 && (
                    <div className="stack">
                        <span className="field__label">These seeds still hold funds</span>
                        {risks.map((seed) => (
                            <div className="stack" key={seed.mnemonic}>
                                <div className="row">
                                    <strong>{seed.label}</strong>
                                    <AddressChip value={seed.mnemonic} display="copy the phrase" />
                                </div>
                                <dl className="rows">
                                    {seed.accounts.map((account) => (
                                        <SeedAccount
                                            key={account.chainLabel}
                                            account={account}
                                            keepRecovery={!wipeRecovery}
                                        />
                                    ))}
                                </dl>
                            </div>
                        ))}
                    </div>
                )}

                {mustAccept && (
                    <Checkbox
                        label="I have copied these phrases, or accept losing what they hold"
                        checked={accepted}
                        onChange={(event) => setAccepted(event.target.checked)}
                    />
                )}

                {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}
            </div>
        </Dialog>
    );
}

function SeedAccount({
    account,
    keepRecovery,
}: {
    account: SeedAtRisk["accounts"][number];
    keepRecovery: boolean;
}) {
    return (
        <>
            <dt>{account.chainLabel}</dt>
            <dd className="rows__prose">
                <span className="mono">
                    {account.balance === null
                        ? "balance unknown"
                        : `${formatAmount(account.balance.raw, account.balance.decimals)} ${account.balance.symbol}`}
                </span>
                {" · "}
                {reachLabel(account.reach, keepRecovery)}
            </dd>
        </>
    );
}
