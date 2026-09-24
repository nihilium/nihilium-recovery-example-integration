/**
 * The on-chain half, as React state.
 *
 * Everything that talks to a chain lives in `integration/recovery/settlement/protect.ts`; this holds
 * the phase, the transcript and the error, and calls it for **one** chain — whichever is on screen.
 * The split is not tidiness: a function closed over the active chain cannot protect a chain that is
 * not active, which is why protecting a two-chain vault used to be two separate errands. The same
 * two functions drive the cross-chain sweep in `useChainCoverage` and `useProtectAll`.
 *
 * It reads the chain rather than remembering, and re-reads after every write: the account can be
 * changed by anything holding its key, so a cached answer would be this app's belief rather than the
 * chain's state.
 */
import { useCallback, useEffect, useState } from "react";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import {
    protectChain,
    readProtection,
    supportsSettlement,
    type OnChainState,
} from "../integration/recovery/settlement/protect.js";
import type { MethodRegistry } from "../integration/conditions/types.js";
import type { AppBindings } from "./bindings.js";

export type { OnChainState };

export interface SettlementState {
    phase: "idle" | "protecting" | "failed";
    onchain: OnChainState | null;
    error: string | null;
    log: string[];
    txHash: string | null;
}

const EMPTY: SettlementState = {
    phase: "idle",
    onchain: null,
    error: null,
    log: [],
    txHash: null,
};

export function useSettlement(
    bindings: AppBindings,
    chain: ChainModule,
    account: DerivedAccount | undefined,
    vault: VaultRecord | null,
    /**
     * Needed only where registering *mints* a key rather than merely naming one — Solana's
     * `register` is signed by the incoming guardian. See `protect.ts`.
     */
    methods: MethodRegistry | null,
    /**
     * Called when a protect has written to the vault ledger itself.
     *
     * Protecting on Solana mints a fresh key for the chain, which makes this hook a second writer of
     * state `useRecoveryFlow` owns. Without telling it, the badge compares the chain's new recovery
     * owner against the record it replaced and reads `stale` forever.
     */
    onVaultChanged?: () => void | Promise<void>,
) {
    const [state, setState] = useState<SettlementState>(EMPTY);
    const [nonce, setNonce] = useState(0);

    const supported = supportsSettlement(chain.id);

    // Re-read whenever the account, the vault or a completed write says the answer may have moved.
    useEffect(() => {
        if (!supported || account === undefined) return;
        let live = true;

        void (async () => {
            try {
                const onchain = await readProtection(
                    { env: bindings.env, stores: bindings.stores },
                    { chain, account, vault },
                );
                // `null` means there was nothing to ask — not that the answer is "nothing". Leaving
                // the previous answer in place beats a setState that says nothing happened.
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
    }, [bindings.env, bindings.stores, chain, account, vault, supported, nonce]);

    const note = useCallback((line: string) => {
        setState((prev) => ({ ...prev, log: [...prev.log, line] }));
    }, []);

    const protect = useCallback(async () => {
        if (account === undefined || vault === null) return;
        setState((prev) => ({ ...prev, phase: "protecting", error: null, log: [], txHash: null }));

        try {
            const result = await protectChain(
                { env: bindings.env, stores: bindings.stores },
                {
                    chain,
                    account,
                    vault,
                    methods,
                    installed: state.onchain?.installed === true,
                    onProgress: note,
                    ...(onVaultChanged ? { onVaultChanged } : {}),
                },
            );
            setState((prev) => ({ ...prev, phase: "idle", txHash: result.txHash }));
            // Re-read rather than assume: the chain is the source of truth for what is installed.
            setNonce((n) => n + 1);
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
    }, [
        account,
        bindings.env,
        bindings.stores,
        chain,
        methods,
        note,
        onVaultChanged,
        state.onchain,
        vault,
    ]);

    return {
        // Masked rather than stored: switching chains must not leave the previous one's answer on
        // screen, and switching back must not have thrown it away.
        state: supported ? state : { ...state, onchain: null },
        protect,
        supported,
        refresh: () => setNonce((n) => n + 1),
    };
}

export type Settlement = ReturnType<typeof useSettlement>;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
