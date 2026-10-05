/**
 * The vault's watch: registered automatically, kept in step with its chains, and read on a timer.
 *
 * **Automatic, which the SDK does not assume.** It treats watching as opt-in, because registering
 * tells the operator that a vault exists and which accounts it protects. This demo registers on its
 * own: the operator is this repo's own server, and the point is to see the alarm. A real wallet asks.
 *
 * **Kept in `localStorage`, not on the vault row.** The row is rewritten from in-memory copies by
 * every seal, add and protect, and a field those writers do not know about would be dropped. The
 * watch id also changes with the chain set, and an imported vault simply registers a fresh one, so
 * there is nothing here worth carrying across devices. A reset clears it with everything else.
 *
 * Demo-shaped, so it lives here: it reads the wallet, the env and the stores.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { WatchtowerUnreachableError } from "@nihilium/recovery-core";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import {
    buildVaultWatch,
    syncVaultWatch,
    watchView,
    type ChainWatchInput,
    type UnwatchedChain,
    type WatchRecord,
    type WatchView,
} from "../integration/recovery/watch.js";
import { readProtection, supportsSettlement } from "../integration/recovery/settlement/protect.js";
import { solanaVaultAddresses } from "../integration/recovery/settlement/solana/addresses.js";
import type { AppBindings } from "./bindings.js";
import type { WalletSnapshot } from "./wallet.js";

/** Matches the server's `WATCHTOWER_POLL_SECONDS` default. Reading a status is one cheap GET. */
const POLL_MS = 15_000;

const KEY = (vaultId: string) => `nihilium-demo-watch:${vaultId}`;

function loadRecord(vaultId: string): WatchRecord | undefined {
    try {
        const raw = window.localStorage.getItem(KEY(vaultId));
        return raw === null ? undefined : (JSON.parse(raw) as WatchRecord);
    } catch {
        return undefined;
    }
}

function saveRecord(vaultId: string, record: WatchRecord | undefined): void {
    try {
        if (record === undefined) window.localStorage.removeItem(KEY(vaultId));
        else window.localStorage.setItem(KEY(vaultId), JSON.stringify(record));
    } catch {
        // Unwritable storage costs a re-registration on the next load, nothing more.
    }
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
    /** Changes whenever protection may have changed. `coverage.rows` re-reads after every protect. */
    trigger: unknown,
): WatchtowerState {
    const [record, setRecord] = useState<WatchRecord | undefined>(undefined);
    const [view, setView] = useState<WatchView>({ state: "off", message: "not registered" });
    const [unwatched, setUnwatched] = useState<readonly UnwatchedChain[]>([]);
    const [checking, setChecking] = useState(false);
    const [syncNonce, setSyncNonce] = useState(0);
    const recordRef = useRef<WatchRecord | undefined>(undefined);

    const vaultId = vault !== null && vault.spent === null ? vault.vaultId : null;

    // 1. Register, or re-register when the set of protected chains changed.
    useEffect(() => {
        if (vaultId === null || vault === null || wallet === null) {
            recordRef.current = undefined;
            setRecord(undefined);
            setUnwatched([]);
            setView({ state: "off", message: vault?.spent != null ? "vault spent" : "not registered" });
            return;
        }
        let cancelled = false;
        const current = recordRef.current?.url === bindings.watchtowerUrl ? recordRef.current : loadRecord(vaultId);
        recordRef.current = current;
        setRecord(current);

        void (async () => {
            const method = bindings.methods?.get(vault.gate.methodId) ?? null;
            const credential = bindings.env.watchRegisterSecret;
            if (method === null) {
                setView({ state: "unknown", message: `method "${vault.gate.methodId}" is not configured` });
                return;
            }

            const chains: ChainWatchInput[] = [];
            const notHere: UnwatchedChain[] = [];
            await Promise.all(
                vault.chains.map(async (row) => {
                    const chain = bindings.chains.get(row.chainId);
                    const account = wallet.accounts[row.chainId]?.[0];
                    const label = chain?.label ?? row.chainId;
                    if (chain === undefined || !supportsSettlement(row.chainId)) {
                        notHere.push({ chainId: row.chainId, label, reason: "no settlement" });
                        return;
                    }
                    if (account === undefined || account.accountId !== row.accountId) {
                        notHere.push({ chainId: row.chainId, label, reason: "not in this wallet" });
                        return;
                    }
                    const onchain = await readProtection(
                        { env: bindings.env, stores: bindings.stores },
                        { chain, account, vault },
                    ).catch(() => null);
                    const solana =
                        row.chainId === "solana-devnet"
                            ? (() => {
                                  const addresses = solanaVaultAddresses({
                                      cluster: "devnet",
                                      creator: account.signer.address,
                                  });
                                  return {
                                      vault: addresses.vault.toBase58(),
                                      programId: addresses.programId.toBase58(),
                                  };
                              })()
                            : undefined;
                    chains.push({ record: row, label, onchain, ...(solana ? { solana } : {}) });
                }),
            );
            if (cancelled) return;

            let plan;
            try {
                const keyAdapter = bindings.chains.get(vault.chains[0]?.chainId ?? "")?.keyAdapter;
                if (keyAdapter === undefined) throw new Error("the vault names no chain this app knows");
                plan = buildVaultWatch({ vault, method, keyAdapter, stores: bindings.stores, chains });
            } catch (error) {
                setView({
                    state: "unknown",
                    message: `could not build a watch: ${error instanceof Error ? error.message : String(error)}`,
                });
                return;
            }
            setUnwatched([...notHere, ...plan.unwatched]);

            // A chain that could not be read keeps the current watch as it is, rather than
            // re-registering without it.
            if (plan.incomplete && current !== undefined) return;
            if (credential === undefined) {
                setView({
                    state: current === undefined ? "off" : "unknown",
                    message: "VITE_WATCH_REGISTER_SECRET is not set. Run `npm run setup:env`.",
                });
                return;
            }

            try {
                const { record: next, changed } = await syncVaultWatch({
                    client: bindings.watchtower(),
                    url: bindings.watchtowerUrl,
                    credential,
                    current,
                    registration: plan.registration,
                });
                if (cancelled) return;
                if (changed) saveRecord(vaultId, next);
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
        // `vault` and `wallet` are read through their identities' stand-ins below: the chain set and
        // the trigger decide when protection may have changed, not every re-render of the objects.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bindings, vaultId, vault?.chains, wallet, trigger, syncNonce]);

    // 2. Read the status on a timer, while a watch exists.
    const read = useCallback(async (watch: WatchRecord) => {
        try {
            const status = await bindings.watchtower().status(watch.watchId);
            setView(watchView({ status }));
        } catch (error) {
            // A watch the server no longer has (its store was wiped) is not a broken watchtower:
            // forget it and register again. Anything else is `unknown`, never quiet.
            if (!(error instanceof WatchtowerUnreachableError) && String(error).includes("No such watch")) {
                if (vaultId !== null) saveRecord(vaultId, undefined);
                recordRef.current = undefined;
                setRecord(undefined);
                setSyncNonce((n) => n + 1);
                return;
            }
            setView(watchView({ error }));
        }
    }, [bindings, vaultId]);

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
