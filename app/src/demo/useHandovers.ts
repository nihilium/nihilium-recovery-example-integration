/**
 * Recoveries that are already on-chain and waiting — the state the wallet view cannot show.
 *
 * Everything else on the page is keyed on the *active seed*, which is exactly the seed a recovery
 * says you no longer have. This hook is keyed on the handover rows instead. The work is the SDK's
 * `moveHandovers`; the sweep each chain module supplies is the one demo-shaped piece, because it
 * signs as the destination seed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { discardVault, handoverProgress, moveHandovers, type HandoverRecord } from "@nihilium/recovery-sdk";
import { destinationFor, destinationsFor } from "./destinations.js";
import { seedFingerprint, type SeedBook } from "./seeds.js";
import { deriveWallet } from "./wallet.js";
import type { AppBindings } from "../wiring.js";

export interface HandoverGroup {
    vaultId: string;
    records: readonly HandoverRecord[];
    progress: ReturnType<typeof handoverProgress>;
    /** The seed control was handed to, by fingerprint. Fixed at recovery time — it is inside the signed intent. */
    ownerWalletId: string;
    /** True when this browser still holds that seed, which the sweep has to sign with. */
    canSign: boolean;
}

export interface CompletedRecovery {
    vaultId: string;
    chains: readonly { chainId: string; sweepTx: string | null }[];
}

export interface HandoverState {
    groups: readonly HandoverGroup[];
    completed: CompletedRecovery | null;
    moving: string | null;
    log: readonly string[];
    error: string | null;
}

export function useHandovers(bindings: AppBindings, seeds: SeedBook, onRecoveryClosed?: () => void) {
    const [records, setRecords] = useState<readonly HandoverRecord[]>([]);
    const [completed, setCompleted] = useState<CompletedRecovery | null>(null);
    const onClosed = useRef(onRecoveryClosed);
    useEffect(() => {
        onClosed.current = onRecoveryClosed;
    }, [onRecoveryClosed]);
    const [moving, setMoving] = useState<string | null>(null);
    const [log, setLog] = useState<readonly string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setRecords(await bindings.deps.handovers.list());
    }, [bindings]);

    useEffect(() => {
        // eslint-disable-next-line react/set-state-in-effect -- reads IndexedDB first; the write lands later
        void reload();
    }, [reload]);

    const known = new Set(seeds.seeds.map((entry) => seedFingerprint(entry.mnemonic)));
    const byVault = new Map<string, HandoverRecord[]>();
    for (const record of records) byVault.set(record.vaultId, [...(byVault.get(record.vaultId) ?? []), record]);
    const groups: HandoverGroup[] = [...byVault.entries()].map(([vaultId, rows]) => ({
        vaultId, records: rows, progress: handoverProgress(rows),
        ownerWalletId: rows[0]?.ownerWalletId ?? "", canSign: known.has(rows[0]?.ownerWalletId ?? ""),
    }));

    /** Change where the funds land, without touching who controls the account. Only `sweepTo` can move. */
    const setDestination = useCallback(
        async (vaultId: string, mnemonic: string) => {
            const owner = await deriveWallet(bindings.chains, mnemonic);
            for (const row of await bindings.deps.handovers.forVault(vaultId)) {
                const sweepTo = owner.accounts[row.chainId]?.[0]?.address;
                if (sweepTo !== undefined) await bindings.deps.handovers.put({ ...row, sweepTo });
            }
            await reload();
        },
        [bindings, reload],
    );

    const movable = useCallback((chainId: string) => bindings.chains.get(chainId)?.settlement !== null && bindings.chains.get(chainId)?.sweep != null, [bindings]);

    /**
     * Discard a recovery once it has done everything it can: every chain this build can hand over
     * has had its funds moved. The spent vault goes with it: its seal opens nothing any more.
     */
    const closeIfFinished = useCallback(
        async (vaultId: string): Promise<boolean> => {
            const rows = await bindings.deps.handovers.forVault(vaultId);
            const carried = rows.filter((row) => movable(row.chainId));
            if (carried.length === 0 || !carried.every((row) => row.stage === "swept")) return false;
            for (const row of rows) await bindings.deps.handovers.delete(row.id);
            await discardVault(bindings.deps, vaultId);
            setCompleted({ vaultId, chains: carried.map((row) => ({ chainId: row.chainId, sweepTx: row.sweepTx })) });
            onClosed.current?.();
            return true;
        },
        [bindings, movable],
    );

    useEffect(() => {
        if (moving !== null) return;
        const swept = [...new Set(records.map((row) => row.vaultId))].filter((vaultId) => records.some((row) => row.vaultId === vaultId && row.stage === "swept"));
        if (swept.length === 0) return;
        void (async () => {
            let closed = false;
            for (const vaultId of swept) closed = (await closeIfFinished(vaultId)) || closed;
            if (closed) await reload();
        })();
    }, [records, moving, closeIfFinished, reload]);

    const move = useCallback(
        async (vaultId: string, chainIds?: readonly string[]) => {
            setMoving(vaultId);
            setError(null);
            setLog([]);
            const note = (line: string) => setLog((prev) => [...prev, line]);
            try {
                const all = await bindings.deps.handovers.forVault(vaultId);
                const rows = chainIds === undefined ? all : all.filter((record) => chainIds.includes(record.chainId));
                // The seed control was handed to. Derived here rather than stored, because storing
                // it would mean storing a key — the thing this whole design avoids.
                const seed = seeds.seeds.find((entry) => seedFingerprint(entry.mnemonic) === rows[0]?.ownerWalletId);
                await moveHandovers(bindings.deps, {
                    records: rows,
                    onProgress: note,
                    sweepFor: (chainId) => {
                        const chain = bindings.chains.get(chainId);
                        const key = seed === undefined ? null : destinationFor(seed.mnemonic, chainId);
                        if (chain?.sweep == null || key === null) return null;
                        return async (record) => chain.sweep!.sweep({
                            accountId: record.accountId,
                            signerAddress: record.signerAddress ?? undefined,
                            to: record.sweepTo,
                            newOwnerPrivateKeyHex: key.exportPrivateKeyHex_DEMO_ONLY(),
                            amount: null,
                            onProgress: note,
                        });
                    },
                });
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

    /** Forget a handover. It does not cancel anything on-chain; it only stops this browser being able to finish it. */
    const discard = useCallback(
        async (vaultId: string) => {
            for (const row of await bindings.deps.handovers.forVault(vaultId)) await bindings.deps.handovers.delete(row.id);
            await reload();
        },
        [bindings, reload],
    );

    const previewDestination = useCallback(
        (mnemonic: string, chainId: string) => destinationsFor(mnemonic).find((d) => d.chainId === chainId) ?? null,
        [],
    );

    return {
        state: { groups, completed, moving, log, error } as HandoverState,
        clearCompleted: useCallback(() => setCompleted(null), []),
        move, setDestination, discard, reload, previewDestination,
    };
}

export type Handovers = ReturnType<typeof useHandovers>;
