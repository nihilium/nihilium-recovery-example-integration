/**
 * The on-chain half, as React state, for **one** chain — whichever is on screen.
 *
 * The work is the SDK's: `readProtection` reads what the chain holds against this vault, and
 * `protect` registers the vault's key through the chain's settlement adapter. This holds the phase,
 * the transcript and the error, and re-reads after every write: the account can be changed by
 * anything holding its key, so a cached answer would be this app's belief rather than the chain's.
 */
import { useCallback, useEffect, useState } from "react";
import { protect, readProtection, type OnChainState, type VaultRecord } from "@nihilium/recovery-sdk";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { MethodRegistry } from "../integration/conditions/types.js";
import type { AppBindings } from "../wiring.js";
import { VETO_CONTEXT, demoVetoConfig } from "./vetoConfig.js";

export type { OnChainState };

export interface SettlementState {
    phase: "idle" | "protecting" | "failed";
    onchain: OnChainState | null;
    error: string | null;
    log: string[];
    txHash: string | null;
}

const EMPTY: SettlementState = { phase: "idle", onchain: null, error: null, log: [], txHash: null };

export function useSettlement(
    bindings: AppBindings,
    chain: ChainModule,
    account: DerivedAccount | undefined,
    vault: VaultRecord | null,
    /** The vault's method, for `addChain` where the chain is not in the vault yet. */
    methods: MethodRegistry | null,
    /** Called when a protect has written to the vault ledger, so the flow re-reads it. */
    onVaultChanged?: () => void | Promise<void>,
) {
    const [state, setState] = useState<SettlementState>(EMPTY);
    const [nonce, setNonce] = useState(0);

    const supported = chain.settlement !== null;

    useEffect(() => {
        if (!supported || account === undefined) return;
        let live = true;
        void (async () => {
            try {
                const onchain = await readProtection({ chain, account: { accountId: account.accountId, signerAddress: account.signer.address }, vault });
                if (!live || onchain === null) return;
                setState((prev) => ({ ...prev, phase: "idle", onchain }));
            } catch (error) {
                // An unreadable chain is not an unprotected account, and must not render as one.
                if (!live) return;
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        })();
        return () => {
            live = false;
        };
    }, [chain, account, vault, supported, nonce]);

    const note = useCallback((line: string) => setState((prev) => ({ ...prev, log: [...prev.log, line] })), []);

    const run = useCallback(async () => {
        if (account === undefined || vault === null) return;
        const gate = methods?.get(vault.gate.methodId) ?? null;
        setState((prev) => ({ ...prev, phase: "protecting", error: null, log: [], txHash: null }));
        try {
            if (gate === null) throw new Error(`Vault sealed with "${vault.gate.methodId}", which is not configured in this app.`);
            // The operator's veto keys, from the relayer, and the wallet's own key as abort.
            const published = await bindings.relay.config(chain.namespace);
            const result = await protect(bindings.deps, {
                chain,
                account: { accountId: account.accountId, signerAddress: account.signer.address, executor: await account.signer.executor() },
                vault,
                gate,
                veto: demoVetoConfig({ namespace: chain.namespace, published, abortAuthority: account.signer.address, timelockSeconds: vault.timelockSeconds }),
                vetoContext: VETO_CONTEXT,
                onProgress: note,
            });
            await onVaultChanged?.();
            setState((prev) => ({ ...prev, phase: "idle", txHash: result.tx?.hash ?? null }));
            // Re-read rather than assume: the chain is the source of truth for what is installed.
            setNonce((n) => n + 1);
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
    }, [account, bindings, chain, methods, note, onVaultChanged, vault]);

    return {
        // Masked rather than stored: switching chains must not leave the previous one's answer on screen.
        state: supported ? state : { ...state, onchain: null },
        protect: run,
        supported,
        refresh: () => setNonce((n) => n + 1),
    };
}

export type Settlement = ReturnType<typeof useSettlement>;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
