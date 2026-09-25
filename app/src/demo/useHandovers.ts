/**
 * Recoveries that are already on-chain and waiting — the state the wallet view cannot show.
 *
 * Everything else on the page is keyed on the *active seed*, which is exactly the seed a recovery
 * says you no longer have. So a submitted handover was invisible: the vault belonged to a wallet the
 * app could not derive, and closing the dialog left no trace that anything was in flight. This hook
 * is keyed on the handover rows instead, so it answers whatever the seed switcher is set to.
 *
 * Demo-shaped because it builds chain clients from `DemoEnv`; the work itself is in
 * `integration/recovery/handover/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    handoverProgress,
    type HandoverRecord,
} from "../integration/recovery/handovers.js";
import { moveAll } from "../integration/recovery/handover/run.js";
import { discardVault } from "../integration/recovery/vault.js";
import { destinationFor, destinationsFor } from "./destinations.js";
import { seedFingerprint, type SeedBook } from "./seeds.js";
import { handoverFor } from "./handoverRegistry.js";
import { deriveWallet } from "./wallet.js";
import type { AppBindings } from "./bindings.js";

export interface HandoverGroup {
    vaultId: string;
    records: readonly HandoverRecord[];
    progress: ReturnType<typeof handoverProgress>;
    /** The seed control was handed to, by fingerprint. Fixed at recovery time — it is inside the signed intent. */
    ownerWalletId: string;
    /** True when this browser still holds that seed, which the sweep has to sign with. */
    canSign: boolean;
}

/** A recovery carried all the way through, kept only long enough to say so. */
export interface CompletedRecovery {
    vaultId: string;
    chains: readonly { chainId: string; sweepTx: string | null }[];
}

export interface HandoverState {
    groups: readonly HandoverGroup[];
    /** The last recovery that finished and was discarded, until the user dismisses the line. */
    completed: CompletedRecovery | null;
    /** Which vault is being moved right now, or `null`. */
    moving: string | null;
    log: readonly string[];
    error: string | null;
}

export function useHandovers(
    bindings: AppBindings,
    seeds: SeedBook,
    /** Called after a finished recovery is discarded, so the vault list can drop the spent vault. */
    onRecoveryClosed?: () => void,
) {
    const [records, setRecords] = useState<readonly HandoverRecord[]>([]);
    const [completed, setCompleted] = useState<CompletedRecovery | null>(null);
    // A ref, so a caller passing a fresh arrow each render does not rebuild everything below it —
    // and re-run the on-load check below on every render.
    const onClosed = useRef(onRecoveryClosed);
    useEffect(() => {
        onClosed.current = onRecoveryClosed;
    }, [onRecoveryClosed]);
    const [moving, setMoving] = useState<string | null>(null);
    const [log, setLog] = useState<readonly string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setRecords(await bindings.handovers.list());
    }, [bindings]);

    useEffect(() => {
        // The rule reads `reload` as a synchronous setState; it is not — it awaits an IndexedDB
        // read first, so the write always lands in a later tick. Reading a store is exactly the
        // "synchronising with an external system" the rule exempts.
        // eslint-disable-next-line react/set-state-in-effect
        void reload();
    }, [reload]);

    const known = new Set(seeds.seeds.map((entry) => seedFingerprint(entry.mnemonic)));
    const byVault = new Map<string, HandoverRecord[]>();
    for (const record of records) {
        const list = byVault.get(record.vaultId) ?? [];
        list.push(record);
        byVault.set(record.vaultId, list);
    }

    const groups: HandoverGroup[] = [...byVault.entries()].map(([vaultId, rows]) => ({
        vaultId,
        records: rows,
        progress: handoverProgress(rows),
        ownerWalletId: rows[0]?.ownerWalletId ?? "",
        canSign: known.has(rows[0]?.ownerWalletId ?? ""),
    }));

    /**
     * Change where the funds land, without touching who controls the account.
     *
     * Only `sweepTo` can move. `newOwner` is inside an intent that was signed by a key the ceremony
     * has already destroyed, so changing it would need another recovery — and the vault is spent.
     */
    const setDestination = useCallback(
        async (vaultId: string, mnemonic: string) => {
            const owner = await deriveWallet(bindings.chains, mnemonic);
            const rows = await bindings.handovers.forVault(vaultId);
            for (const row of rows) {
                const sweepTo = owner.accounts[row.chainId]?.[0]?.address;
                if (sweepTo === undefined) continue;
                await bindings.handovers.put({ ...row, sweepTo });
            }
            await reload();
        },
        [bindings, reload],
    );

    /**
     * Discard a recovery once it has done everything it can: every chain this build can hand over
     * has had its funds moved. Only then — a failed sweep, or a chain still counting down, keeps the
     * rows, because a submitted row is the only record of an intent whose signing key is gone.
     *
     * Chains with no handover in this build at all (Zcash) never move and never will; they do not
     * hold a finished recovery open. The spent vault goes with it: its seal opens nothing any more,
     * and its keys were exposed by the recovery that just finished.
     */
    const closeIfFinished = useCallback(
        async (vaultId: string): Promise<boolean> => {
            const rows = await bindings.handovers.forVault(vaultId);
            const movable = rows.filter((row) => handoverFor(bindings, row.chainId) !== null);
            if (movable.length === 0 || !movable.every((row) => row.stage === "swept")) return false;

            for (const row of rows) await bindings.handovers.delete(row.id);
            await discardVault(bindings.stores, vaultId);
            setCompleted({
                vaultId,
                chains: movable.map((row) => ({ chainId: row.chainId, sweepTx: row.sweepTx })),
            });
            onClosed.current?.();
            return true;
        },
        [bindings],
    );

    // Also on load: a recovery swept before this rule existed, or in a session that closed before
    // the check ran, would otherwise hold its tab open for good. `closeIfFinished` re-reads the rows
    // and decides; this only skips the obvious non-candidates.
    useEffect(() => {
        if (moving !== null) return;
        const swept = [...new Set(records.map((row) => row.vaultId))].filter((vaultId) =>
            records.some((row) => row.vaultId === vaultId && row.stage === "swept"),
        );
        if (swept.length === 0) return;
        void (async () => {
            let closed = false;
            for (const vaultId of swept) closed = (await closeIfFinished(vaultId)) || closed;
            // Only when something went: reloading unconditionally hands back a new array, which
            // re-runs this effect — forever, for a vault that is part-way swept.
            if (closed) await reload();
        })();
    }, [records, moving, closeIfFinished, reload]);

    const move = useCallback(
        /**
         * `chainIds` narrows the run to the chains the chain says are ready. Without it every row
         * is attempted, and a chain still counting down comes back with a revert reason for a
         * button the user was told would work.
         */
        async (vaultId: string, chainIds?: readonly string[]) => {
            setMoving(vaultId);
            setError(null);
            setLog([]);
            const note = (line: string) => setLog((prev) => [...prev, line]);
            try {
                const all = await bindings.handovers.forVault(vaultId);
                const rows =
                    chainIds === undefined
                        ? all
                        : all.filter((record) => chainIds.includes(record.chainId));
                await moveAll(
                    {
                        chains: bindings.chains,
                        store: bindings.handovers,
                        handoverFor: (chainId) => handoverFor(bindings, chainId),
                        serverUrl: bindings.env.serverUrl,
                        onProgress: note,
                    },
                    {
                        records: rows,
                        // The seed control was handed to. Derived here rather than stored, because
                        // storing it would mean storing a key — the thing this whole design avoids.
                        ownerKeyFor: (chainId) => {
                            const seed = seeds.seeds.find(
                                (entry) => seedFingerprint(entry.mnemonic) === rows[0]?.ownerWalletId,
                            );
                            if (seed === undefined) return null;
                            return (
                                destinationFor(seed.mnemonic, chainId)?.exportPrivateKeyHex_DEMO_ONLY() ??
                                null
                            );
                        },
                    },
                );
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
                setMoving(null);
                await closeIfFinished(vaultId);
                await reload();
            }
        },
        [bindings, reload, seeds.seeds, closeIfFinished],
    );

    /**
     * Forget a handover.
     *
     * Destructive in a way that cannot be undone: a submitted row is the **only** record of an
     * intent, and the key that signed it was destroyed on purpose at recovery time. Discarding one
     * does not cancel it on-chain — the timelock keeps running and the recovery stays executable by
     * anyone holding a copy of that intent — it only stops this browser being able to finish it.
     */
    const discard = useCallback(
        async (vaultId: string) => {
            for (const row of await bindings.handovers.forVault(vaultId)) {
                await bindings.handovers.delete(row.id);
            }
            await reload();
        },
        [bindings, reload],
    );

    /** Kept so a caller can show where funds would land before committing to it. */
    const previewDestination = useCallback(
        (mnemonic: string, chainId: string) => destinationsFor(mnemonic).find((d) => d.chainId === chainId) ?? null,
        [],
    );

    return {
        state: { groups, completed, moving, log, error } as HandoverState,
        clearCompleted: useCallback(() => setCompleted(null), []),
        move,
        setDestination,
        discard,
        reload,
        previewDestination,
    };
}

export type Handovers = ReturnType<typeof useHandovers>;
