/**
 * The vault's watch: registered automatically, kept in step with its chains, and read on a timer.
 *
 * **Automatic, which the SDK does not assume.** It treats watching as opt-in, because registering
 * tells the operator that a vault exists and which accounts it protects. This demo registers on its
 * own: the operator is this repo's own server. A real wallet asks.
 *
 * The record of each vault's watch lives in the SDK's `watches` store beside the vault.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { WatchtowerUnreachableError } from "@nihilium/recovery-core";
import {
    buildVaultWatch,
    readProtection,
    syncVaultWatch,
    watchView,
    type ChainWatchInput,
    type VaultRecord,
    type VaultWatchRecord,
    type WatchView,
} from "@nihilium/recovery-sdk";
import type { AppBindings } from "../wiring.js";
import type { WalletSnapshot } from "./wallet.js";

/** Matches the server's `WATCHTOWER_POLL_SECONDS` default. Reading a status is one cheap GET. */
const POLL_MS = 15_000;

/** A chain with no on-chain target, labelled for the card. */
export interface UnwatchedChain {
    chainId: string;
    label: string;
    reason: string;
}

export interface WatchtowerState {
    view: WatchView;
    unwatched: readonly UnwatchedChain[];
    checking: boolean;
    /** Poll now, on the server, then read. The server's `POST /poll` is a demo affordance. */
    checkNow(): void;
}

export function useWatchtower(
    bindings: AppBindings,
    wallet: WalletSnapshot | null,
    vault: VaultRecord | null,
    /** Changes whenever protection may have changed. */
    trigger: unknown,
): WatchtowerState {
    const [record, setRecord] = useState<VaultWatchRecord | undefined>(undefined);
    const [view, setView] = useState<WatchView>({ state: "off", message: "not registered" });
    const [unwatched, setUnwatched] = useState<readonly UnwatchedChain[]>([]);
    const [checking, setChecking] = useState(false);
    const [syncNonce, setSyncNonce] = useState(0);
    const recordRef = useRef<VaultWatchRecord | undefined>(undefined);
    const watches = bindings.deps.watches;

    const vaultId = vault !== null && vault.spent === null ? vault.vaultId : null;

    // 1. Register, or re-register when the set of protected chains changed.
    useEffect(() => {
        if (vaultId === null || vault === null || wallet === null || watches === undefined) {
            recordRef.current = undefined;
            setRecord(undefined);
            setUnwatched([]);
            setView({ state: "off", message: vault?.spent != null ? "vault spent" : "not registered" });
            return;
        }
        let cancelled = false;

        void (async () => {
            const method = bindings.methods?.get(vault.gate.methodId) ?? null;
            const credential = bindings.env.watchRegisterSecret;
            if (method === null) {
                setView({ state: "unknown", message: `method "${vault.gate.methodId}" is not configured` });
                return;
            }
            const current = recordRef.current?.url === bindings.watchtowerUrl ? recordRef.current : await watches.get(vaultId);
            recordRef.current = current;
            setRecord(current);

            const chains: ChainWatchInput[] = [];
            const notHere: UnwatchedChain[] = [];
            await Promise.all(
                vault.chains.map(async (row) => {
                    const chain = bindings.chains.get(row.chainId);
                    const account = wallet.accounts[row.chainId]?.[0];
                    const label = chain?.label ?? row.chainId;
                    if (chain === undefined || chain.settlement === null) {
                        notHere.push({ chainId: row.chainId, label, reason: "no settlement" });
                        return;
                    }
                    if (account === undefined || account.accountId !== row.accountId) {
                        notHere.push({ chainId: row.chainId, label, reason: "not in this wallet" });
                        return;
                    }
                    const onchain = await readProtection({ chain, account: { accountId: row.accountId, ...(row.signerAddress ? { signerAddress: row.signerAddress } : {}) }, vault }).catch(() => null);
                    chains.push({ record: row, onchain });
                }),
            );
            if (cancelled) return;

            let plan;
            try {
                plan = buildVaultWatch(bindings.deps, { vault, gate: method, chains });
            } catch (error) {
                setView({ state: "unknown", message: `could not build a watch: ${error instanceof Error ? error.message : String(error)}` });
                return;
            }
            const labelOf = (chainId: string) => bindings.chains.get(chainId)?.label ?? chainId;
            setUnwatched([...notHere, ...plan.unwatched.map((row) => ({ ...row, label: labelOf(row.chainId) }))]);

            // A chain that could not be read keeps the current watch as it is.
            if (plan.incomplete && current !== undefined) return;
            if (credential === undefined) {
                setView({ state: current === undefined ? "off" : "unknown", message: "VITE_WATCH_REGISTER_SECRET is not set. Run `npm run setup:env`." });
                return;
            }
            try {
                const { record: next, changed } = await syncVaultWatch({
                    client: bindings.watchtower(), url: bindings.watchtowerUrl, credential, vaultId, current, registration: plan.registration,
                });
                if (cancelled) return;
                if (changed) await watches.put(next);
                recordRef.current = next;
                setRecord(next);
            } catch (error) {
                if (cancelled) return;
                setView(watchView({ error }));
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the chain set and the trigger decide when protection may have changed
    }, [bindings, vaultId, vault?.chains, wallet, trigger, syncNonce]);

    // 2. Read the status on a timer, while a watch exists.
    const read = useCallback(async (watch: VaultWatchRecord) => {
        try {
            const status = await bindings.watchtower().status(watch.watchId);
            setView(watchView({ status }));
        } catch (error) {
            // A watch the server no longer has is not a broken watchtower: forget it and register again.
            if (!(error instanceof WatchtowerUnreachableError) && String(error).includes("No such watch")) {
                if (vaultId !== null) await watches?.delete(vaultId);
                recordRef.current = undefined;
                setRecord(undefined);
                setSyncNonce((n) => n + 1);
                return;
            }
            setView(watchView({ error }));
        }
    }, [bindings, vaultId, watches]);

    useEffect(() => {
        if (record === undefined) return;
        void read(record);
        const timer = setInterval(() => void read(record), POLL_MS);
        return () => clearInterval(timer);
    }, [record, read]);

    const checkNow = useCallback(() => {
        const watch = recordRef.current;
        if (watch === undefined) return;
        setChecking(true);
        void fetch(`${bindings.watchtowerUrl}/poll`, { method: "POST" })
            .catch(() => undefined)
            .then(() => read(watch))
            .finally(() => setChecking(false));
    }, [bindings, read]);

    return { view, unwatched, checking, checkNow };
}
