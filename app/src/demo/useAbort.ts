/**
 * Killing a recovery, as the owner.
 *
 * **Driven from the vault, not from the handover rows.** An attempt exists on-chain whether or not
 * this browser has a record of it — a recovery somebody else opened has no row here at all, and that
 * is precisely the case abort exists for. Keying this on stored rows would make it unavailable
 * exactly when it is needed.
 *
 * **The authority is the wallet's own key**, which the SDK calls the natural default: the common
 * case is not a rogue provider, it is somebody opening a recovery while the owner still has access,
 * and the obvious party to stop that is whoever holds the key. Two consequences this hook has to
 * live with, and neither is hidden:
 *
 * - The relayer cannot help. `initiate` and `execute` carry authority in a signature, so anyone with
 *   gas may submit them; `abort` checks the sender, so this key signs and pays for itself.
 * - In the true seed-loss case the key is gone, and so is abort. That is the price of seating it
 *   with the owner rather than with a third party, and `canAbort` reports it rather than hiding the
 *   button.
 */
import { useCallback, useState } from "react";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { handoverFor } from "./handoverRegistry.js";
import { deriveWallet } from "./wallet.js";
import { seedFingerprint, type SeedBook } from "./seeds.js";
import type { AppBindings } from "./bindings.js";

export interface AbortOutcome {
    chainId: string;
    hash: string | null;
    failure: string | null;
}

export function useAbort(bindings: AppBindings, seeds: SeedBook) {
    const [running, setRunning] = useState(false);
    const [log, setLog] = useState<readonly string[]>([]);
    const [outcomes, setOutcomes] = useState<readonly AbortOutcome[]>([]);

    /** Whether this browser still holds the seed the vault's abort authority is derived from. */
    const canAbort = useCallback(
        (vault: VaultRecord | null) =>
            vault !== null &&
            seeds.seeds.some((entry) => seedFingerprint(entry.mnemonic) === vault.walletId),
        [seeds.seeds],
    );

    const abort = useCallback(
        async (vault: VaultRecord) => {
            const seed = seeds.seeds.find(
                (entry) => seedFingerprint(entry.mnemonic) === vault.walletId,
            );
            if (seed === undefined) return;

            setRunning(true);
            setOutcomes([]);
            setLog([]);
            const note = (line: string) => setLog((prev) => [...prev, line]);

            try {
                // The vault's own wallet, not the active one. Abort is the owner's power, and the
                // owner here is whoever the vault was sealed against.
                const owner = await deriveWallet(bindings.chains, seed.mnemonic);
                const results: AbortOutcome[] = [];

                for (const record of vault.chains) {
                    const handover = handoverFor(bindings, record.chainId);
                    const account = owner.accounts[record.chainId]?.[0];
                    if (handover === null || account === undefined) {
                        results.push({
                            chainId: record.chainId,
                            hash: null,
                            failure: "No settlement is wired for this chain in this build.",
                        });
                        continue;
                    }
                    try {
                        const { hash } = await handover.abort({
                            chainRecord: {
                                accountId: record.accountId,
                                signerAddress: record.signerAddress,
                                recoveryPubKeyHex: record.recoveryPubKeyHex,
                            },
                            serverUrl: bindings.env.serverUrl,
                            authorityPrivateKeyHex:
                                account.signer.exportPrivateKeyHex_DEMO_ONLY(),
                            onProgress: note,
                        });
                        results.push({ chainId: record.chainId, hash, failure: null });
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        note(`abort      ${record.chainId} ✗ ${reason}`);
                        results.push({ chainId: record.chainId, hash: null, failure: reason });
                    }
                }
                setOutcomes(results);

                // The rows are the only record of an intent, and an aborted attempt can never be
                // executed — so keeping them would leave a Handover view offering a button that
                // cannot work.
                for (const row of await bindings.handovers.forVault(vault.vaultId)) {
                    await bindings.handovers.delete(row.id);
                }
            } finally {
                setRunning(false);
            }
        },
        [bindings, seeds.seeds],
    );

    return { abort, canAbort, running, log, outcomes };
}

export type Abort = ReturnType<typeof useAbort>;
