/**
 * Every chain at once: what it holds, and whether it holds anything worth protecting.
 *
 * Fans out per chain, with a failure recorded on the row and never a throw that takes the other
 * chains with it. Reads on demand rather than on a timer: it backs a dialog.
 */
import { useCallback, useEffect, useState } from "react";
import { readProtection, type CoverageRow, type VaultRecord } from "@nihilium/recovery-sdk";
import type { AppBindings } from "../wiring.js";
import type { WalletSnapshot } from "./wallet.js";

const NONE: readonly CoverageRow[] = [];

export interface ChainCoverage {
    rows: readonly CoverageRow[];
    loading: boolean;
    refresh(): void;
}

export function useChainCoverage(bindings: AppBindings, wallet: WalletSnapshot | null, vault: VaultRecord | null, paused = false): ChainCoverage {
    const [loaded, setLoaded] = useState<{ key: string; rows: readonly CoverageRow[] }>({ key: "", rows: [] });
    const [nonce, setNonce] = useState(0);
    const registry = bindings.chains;
    const key = wallet === null ? "none" : `${wallet.recoveryTarget.address}:${vault?.vaultId ?? "-"}:${nonce}`;

    useEffect(() => {
        if (wallet === null) return;
        let live = true;
        void (async () => {
            const next = await readCoverage({ chains: registry }, wallet, vault);
            if (!live) return;
            setLoaded({ key, rows: next });
        })();
        return () => {
            live = false;
        };
    }, [registry, wallet, vault, key]);

    // Re-read when the user comes back to the tab: funding happens somewhere else.
    useEffect(() => {
        if (paused) return;
        const onVisible = () => {
            if (document.visibilityState === "visible") setNonce((n) => n + 1);
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        return () => {
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onVisible);
        };
    }, [paused]);

    const current = loaded.key === key;
    return { rows: current ? loaded.rows : NONE, loading: !current && wallet !== null, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

/** One wallet's coverage, as a plain read: every chain, its balance, and what its construction holds. */
export async function readCoverage(bindings: Pick<AppBindings, "chains">, wallet: WalletSnapshot, vault: VaultRecord | null): Promise<CoverageRow[]> {
    return Promise.all(
        bindings.chains.all().map(async (chain): Promise<CoverageRow> => {
            const account = wallet.accounts[chain.id]?.[0];
            const base: CoverageRow = {
                chainId: chain.id, chainLabel: chain.label, settles: chain.settlement !== null,
                hasVault: vault !== null, vaultSpent: vault?.spent != null,
                balanceRaw: null, balanceError: account === undefined ? "no account derived" : null,
                balanceDecimals: null, balanceSymbol: null, onchain: null, onchainError: null,
            };
            if (account === undefined) return base;
            const [balance, onchain] = await Promise.allSettled([
                chain.balanceOf(account.address),
                chain.settlement !== null
                    ? readProtection({ chain, account: { accountId: account.accountId, signerAddress: account.signer.address }, vault })
                    : Promise.resolve(null),
            ]);
            return {
                ...base,
                balanceRaw: balance.status === "fulfilled" ? balance.value.raw : null,
                balanceDecimals: balance.status === "fulfilled" ? balance.value.decimals : null,
                balanceSymbol: balance.status === "fulfilled" ? balance.value.symbol : null,
                balanceSimulated: balance.status === "fulfilled" && balance.value.source === "simulated",
                balanceError: balance.status === "rejected" ? messageOf(balance.reason) : null,
                onchain: onchain.status === "fulfilled" && onchain.value !== null
                    ? { installed: onchain.value.installed, matchesVault: onchain.value.matchesVault, ...(onchain.value.construction?.outdated ? { outdated: true } : {}) }
                    : null,
                onchainError: onchain.status === "rejected" ? messageOf(onchain.reason) : null,
            };
        }),
    );
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
