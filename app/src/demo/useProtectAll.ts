/**
 * One press, every chain that needs it.
 *
 * A loop over `protectChain`, and the two things that make it more than a loop:
 *
 * **Per-chain failure is a row, never a throw.** Chains fail independently and for unrelated reasons
 * — a relayer that is down for one namespace, an RPC that rate-limits, a chain whose account was
 * never funded. Aborting the loop would leave the chains that worked unreported and the ones after
 * the failure untouched, with nothing on screen saying which was which.
 *
 * **The vault is re-read between chains.** Protecting a chain the gate has not reached calls
 * `addChainToVault`, which writes a new record; handing the *next* chain the record we started with
 * would write that chain's row over a copy that predates the first one, silently dropping it. The
 * store is the only thing that knows what the last iteration wrote, so each chain asks it.
 */
import { useCallback, useState } from "react";
import type { ProtectAction, ProtectTarget } from "../integration/recovery/settlement/coverage.js";
import { protectChain } from "../integration/recovery/settlement/protect.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { MethodRegistry } from "../integration/conditions/types.js";
import type { AppBindings } from "./bindings.js";
import type { WalletSnapshot } from "./wallet.js";

export interface ProtectAllResult {
    chainId: string;
    chainLabel: string;
    action: ProtectAction;
    /** `null` on success. Otherwise the reason, as the chain gave it. */
    failure: string | null;
    txHash: string | null;
}

export interface ProtectAll {
    running: boolean;
    log: readonly string[];
    results: readonly ProtectAllResult[];
    /** True once a run has finished, so the dialog can show results rather than the offer. */
    done: boolean;
    run(targets: readonly ProtectTarget[]): Promise<void>;
    reset(): void;
}

export function useProtectAll(
    bindings: AppBindings,
    vault: VaultRecord | null,
    wallet: WalletSnapshot | null,
    methods: MethodRegistry | null,
    /** Called once at the end, whatever happened: the ledger and every chain read are now stale. */
    onDone?: () => void | Promise<void>,
): ProtectAll {
    const [running, setRunning] = useState(false);
    const [done, setDone] = useState(false);
    const [log, setLog] = useState<readonly string[]>([]);
    const [results, setResults] = useState<readonly ProtectAllResult[]>([]);

    const run = useCallback(
        async (targets: readonly ProtectTarget[]) => {
            if (vault === null || wallet === null || targets.length === 0) return;
            setRunning(true);
            setDone(false);
            setLog([]);
            setResults([]);

            const note = (line: string) => setLog((prev) => [...prev, line]);
            const out: ProtectAllResult[] = [];

            for (const target of targets) {
                const chain = bindings.chains.get(target.chainId);
                const account = wallet.accounts[target.chainId]?.[0];
                const base = { chainId: target.chainId, chainLabel: target.chainLabel, action: target.action };

                if (chain === undefined || account === undefined) {
                    out.push({ ...base, failure: "No account is derived for this chain.", txHash: null });
                    setResults([...out]);
                    continue;
                }

                // See the header: the record this chain writes has to build on what the last one
                // wrote, and only the store knows that.
                const current = (await bindings.vaults.get(vault.vaultId)) ?? vault;

                note(`── ${target.chainLabel}`);
                try {
                    const result = await protectChain(
                        { env: bindings.env, stores: bindings.stores },
                        {
                            chain,
                            account,
                            vault: current,
                            methods,
                            installed: target.action === "update",
                            onProgress: note,
                        },
                    );
                    out.push({ ...base, failure: null, txHash: result.txHash });
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    note(`   ✗ ${reason}`);
                    out.push({ ...base, failure: reason, txHash: null });
                }
                setResults([...out]);
            }

            setRunning(false);
            setDone(true);
            await onDone?.();
        },
        [bindings, methods, onDone, vault, wallet],
    );

    return {
        running,
        log,
        results,
        done,
        run,
        reset: useCallback(() => {
            setLog([]);
            setResults([]);
            setDone(false);
        }, []),
    };
}
