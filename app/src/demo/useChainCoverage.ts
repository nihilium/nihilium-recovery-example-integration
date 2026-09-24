/**
 * Every chain at once: what it holds, and whether it holds anything worth protecting.
 *
 * The rest of the app asks these questions one chain at a time, about whichever chain is on screen —
 * `useSettlement` is built for a single `ChainModule` and `useBalances` blanks itself when the chain
 * changes. That is right for a card about one chain and useless for a button about all of them, so
 * this fans out instead, in the shape `useTimelocks` already uses: per-chain `try/catch`, a failure
 * recorded on the row, and never a throw that takes the other chains with it.
 *
 * Reads on demand rather than on a timer. It backs a dialog, and a dialog that is not open is a poll
 * nobody is reading.
 *
 * Rows are stored **with the wallet and vault they describe**, the way `useBalances` stores a chain
 * with its balances: a set whose key no longer matches is not stale, it is *absent*, and absent
 * renders as loading. That keeps "am I still loading?" a derivation rather than a second `setState`
 * at the top of the effect, which is a render that says nothing happened yet.
 */
import { useCallback, useEffect, useState } from "react";
import type { CoverageRow } from "../integration/recovery/settlement/coverage.js";
import {
    readProtection,
    supportsSettlement,
} from "../integration/recovery/settlement/protect.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { AppBindings } from "./bindings.js";
import type { WalletSnapshot } from "./wallet.js";

/** One identity for "nothing yet", so a caller memoising on `rows` is not recomputing forever. */
const NONE: readonly CoverageRow[] = [];

export interface ChainCoverage {
    rows: readonly CoverageRow[];
    loading: boolean;
    refresh(): void;
}

export function useChainCoverage(
    bindings: AppBindings,
    wallet: WalletSnapshot | null,
    /** The gate this wallet holds at all, across whichever chains `addChain()` has reached. */
    vault: VaultRecord | null,
): ChainCoverage {
    const [loaded, setLoaded] = useState<{ key: string; rows: readonly CoverageRow[] }>({
        key: "",
        rows: [],
    });
    const [nonce, setNonce] = useState(0);

    // `bindings.chains`, never `bindings.chains.all()`: the registry is stable, but `all()` copies
    // its list on every call, so an effect depending on the array re-runs on every render — and this
    // effect makes a round of RPC calls. The list is read inside instead.
    const registry = bindings.chains;
    const env = bindings.env;
    const stores = bindings.stores;

    // Identifies the answer, not the wallet: the recovery target is seed-derived and public, so it
    // distinguishes two wallets without a mnemonic ending up in a cache key.
    const key =
        wallet === null ? "none" : `${wallet.recoveryTarget.address}:${vault?.vaultId ?? "-"}:${nonce}`;

    useEffect(() => {
        if (wallet === null) return;
        let live = true;

        void (async () => {
            const next = await Promise.all(
                registry.all().map(async (chain): Promise<CoverageRow> => {
                    // `accounts[0]` is *the* account on every chain — the smart account on EVM, the
                    // vault PDA on Solana — so it is the one whose balance a sweep would move.
                    const account = wallet.accounts[chain.id]?.[0];
                    const base: CoverageRow = {
                        chainId: chain.id,
                        chainLabel: chain.label,
                        settles: supportsSettlement(chain.id),
                        hasVault: vault !== null,
                        vaultSpent: vault?.spent != null,
                        balanceRaw: null,
                        balanceError: account === undefined ? "no account derived" : null,
                        balanceDecimals: null,
                        balanceSymbol: null,
                        onchain: null,
                        onchainError: null,
                    };
                    if (account === undefined) return base;

                    // Independently, and neither failure takes the other down: a chain whose balance
                    // is unreadable but whose module reads fine is still actionable, and the reverse
                    // is worth saying out loud.
                    const [balance, onchain] = await Promise.allSettled([
                        chain.balanceOf(account.address),
                        supportsSettlement(chain.id)
                            ? readProtection({ env, stores }, { chain, account, vault })
                            : Promise.resolve(null),
                    ]);

                    return {
                        ...base,
                        balanceRaw: balance.status === "fulfilled" ? balance.value.raw : null,
                        balanceDecimals:
                            balance.status === "fulfilled" ? balance.value.decimals : null,
                        balanceSymbol: balance.status === "fulfilled" ? balance.value.symbol : null,
                        balanceError:
                            balance.status === "rejected" ? messageOf(balance.reason) : null,
                        onchain:
                            onchain.status === "fulfilled" && onchain.value !== null
                                ? {
                                      installed: onchain.value.installed,
                                      matchesVault: onchain.value.matchesVault,
                                  }
                                : null,
                        onchainError:
                            onchain.status === "rejected" ? messageOf(onchain.reason) : null,
                    };
                }),
            );
            if (!live) return;
            setLoaded({ key, rows: next });
        })();

        return () => {
            live = false;
        };
    }, [registry, env, stores, wallet, vault, key]);

    const current = loaded.key === key;
    return {
        rows: current ? loaded.rows : NONE,
        loading: !current && wallet !== null,
        refresh: useCallback(() => setNonce((n) => n + 1), []),
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
