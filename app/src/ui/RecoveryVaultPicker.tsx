/**
 * Which vault is being recovered — step one, and the step that used not to exist.
 *
 * **The hole this fills.** The only route into a recovery used to be a link on the wallet card,
 * rendered when the *active* seed already had a vault. So the moment you did the thing recovery
 * exists for — lose the seed, move to a new one — the old seed's gate became unreachable: visible
 * nowhere, openable never. A new seed has no vault, so it had nothing to offer, and the vault that
 * needed opening belonged to a wallet the app could no longer derive.
 *
 * So this is keyed on the **vault**, and the ones whose seed is gone come first. They are the only
 * rows that are a rescue rather than a rehearsal.
 *
 * Deleting is here for the same reason: a seal is bearer material, and the place to decide this
 * browser should stop holding one is the place that lists what it holds.
 */
import { useRef, useState } from "react";
import type { CachedRecovery, RecoveryCatalogue } from "../integration/recovery/recoveryCatalogue.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { Button, StatusMessage } from "./ds.js";
import { Notice } from "./Notice.js";

export function RecoveryVaultPicker({
    catalogue,
    chainLabels,
    chosen,
    onChoose,
    onDelete,
    onImportSeal,
}: {
    catalogue: RecoveryCatalogue;
    /** chainId → label, so a row can name what recovering it covers without importing the registry. */
    chainLabels: Readonly<Record<string, string>>;
    chosen: VaultRecord | null;
    onChoose: (vault: VaultRecord) => void;
    onDelete: (row: CachedRecovery) => void;
    /** Reads a seal file and adds whatever it carries. Rejects with a reason the user can act on. */
    onImportSeal: (file: File) => Promise<void>;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const nothing = catalogue.lost.length === 0 && catalogue.present.length === 0;

    return (
        <div className="stack">
            {nothing && (
                <p className="muted">
                    No vaults in this browser. Load a seal file.
                </p>
            )}

            {catalogue.lost.length > 0 && (
                <div className="field">
                    {/* First, and labelled as the real case: the wallet these protect cannot be
                        derived here any more, which is what a recovery is for. */}
                    <span className="field__label">Seed not in this browser</span>
                    <div className="stack">
                        {catalogue.lost.map((row) => (
                            <VaultRow
                                key={row.vault.vaultId}
                                row={row}
                                chainLabels={chainLabels}
                                active={chosen?.vaultId === row.vault.vaultId}
                                onChoose={() => onChoose(row.vault)}
                                onDelete={() => onDelete(row)}
                            />
                        ))}
                    </div>
                </div>
            )}

            {catalogue.present.length > 0 && (
                <div className="field">
                    <span className="field__label">Seed in this browser</span>
                    <div className="stack">
                        {catalogue.present.map((row) => (
                            <VaultRow
                                key={row.vault.vaultId}
                                row={row}
                                chainLabels={chainLabels}
                                active={chosen?.vaultId === row.vault.vaultId}
                                onChoose={() => onChoose(row.vault)}
                                onDelete={() => onDelete(row)}
                            />
                        ))}
                    </div>
                </div>
            )}

            <div className="row">
                <input
                    ref={input}
                    type="file"
                    accept="application/json,.json"
                    className="visually-hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        // Cleared either way, so picking the same file twice fires again.
                        event.target.value = "";
                        if (file === undefined) return;
                        setImportError(null);
                        void onImportSeal(file).catch((failure: unknown) =>
                            setImportError(
                                failure instanceof Error ? failure.message : String(failure),
                            ),
                        );
                    }}
                />
                <Button variant="ghost" onClick={() => input.current?.click()}>
                    Load a seal file
                </Button>
            </div>

            {importError !== null && <StatusMessage tone="error">{importError}</StatusMessage>}

        </div>
    );
}

function VaultRow({
    row,
    chainLabels,
    active,
    onChoose,
    onDelete,
}: {
    row: CachedRecovery;
    chainLabels: Readonly<Record<string, string>>;
    active: boolean;
    onChoose: () => void;
    onDelete: () => void;
}) {
    const spent = row.vault.spent !== null;
    const chains = row.chainIds.map((id) => chainLabels[id] ?? id).join(" · ");
    /**
     * A spent vault is still openable, and saying otherwise strands people.
     *
     * The rule is that a spent vault is never *silently* reused — the exposure already happened and
     * a second opening does not make it worse. What a re-run does cost is another ceremony: real
     * money, and the guardians emailed again. So it is offered with that written on it rather than
     * refused, because the case where it matters is the one where the first attempt got its keys
     * and then failed to submit them, and refusing leaves funds that nothing can reach.
     *
     * No seal here is different: that is not a price, it is an impossibility.
     */
    const usable = row.hasSeal;

    return (
        <div className="recovery-row">
            <button
                type="button"
                className={active ? "gate-option gate-option--active" : "gate-option"}
                aria-pressed={active}
                disabled={!usable}
                onClick={onChoose}
            >
                <span className="gate-option__title">
                    {/* The gate's own summary, kept verbatim at seal time so a vault still describes
                        itself when the method that built it is no longer configured. */}
                    {row.vault.gate.summary ?? "gate unknown"}
                </span>
                <span className="gate-option__gate mono">
                    {row.vault.vaultId} · {chains || "no chains"}
                    {spent
                        ? " · already recovered · recovering again is paid"
                        : row.hasSeal
                          ? ""
                          : " · no seal here"}
                </span>
            </button>
            <button type="button" className="linkish seed-row__note" onClick={onDelete}>
                Delete
            </button>

            {!row.hasSeal && !spent && (
                <Notice tone="caution">
                    Seal missing. Load the seal file.
                </Notice>
            )}
        </div>
    );
}
