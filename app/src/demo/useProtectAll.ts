/**
 * One press, every chain that needs it: the SDK's `protectAll`, which re-reads the ledger between
 * chains and reports a failure as a row rather than a throw.
 */
import { useCallback, useState } from "react";
import { protectAll, type ProtectAction, type ProtectAllTarget, type ProtectTarget, type VaultRecord } from "@nihilium/recovery-sdk";
import type { MethodRegistry } from "../integration/conditions/types.js";
import type { AppBindings } from "../wiring.js";
import type { WalletSnapshot } from "./wallet.js";
import { VETO_CONTEXT, demoVetoConfig } from "./vetoConfig.js";

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
            const gate = methods?.get(vault.gate.methodId) ?? null;
            const out: ProtectAllResult[] = [];

            // What each chain needs, resolved before the loop: a failure here is a row too.
            const resolved: ProtectAllTarget[] = [];
            for (const target of targets) {
                const chain = bindings.chains.get(target.chainId);
                const account = wallet.accounts[target.chainId]?.[0];
                const base = { chainId: target.chainId, chainLabel: target.chainLabel, action: target.action };
                if (chain === undefined || account === undefined) {
                    out.push({ ...base, failure: "No account is derived for this chain.", txHash: null });
                    continue;
                }
                try {
                    const published = await bindings.relay.config(chain.namespace);
                    resolved.push({
                        chain,
                        account: { accountId: account.accountId, signerAddress: account.signer.address, executor: await account.signer.executor() },
                        veto: demoVetoConfig({ namespace: chain.namespace, published, abortAuthority: account.signer.address, timelockSeconds: vault.timelockSeconds }),
                        vetoContext: VETO_CONTEXT,
                    });
                } catch (error) {
                    out.push({ ...base, failure: error instanceof Error ? error.message : String(error), txHash: null });
                }
            }
            setResults([...out]);

            if (gate === null) {
                for (const target of resolved) {
                    const asked = targets.find((t) => t.chainId === target.chain.id)!;
                    out.push({ chainId: target.chain.id, chainLabel: asked.chainLabel, action: asked.action, failure: `Vault sealed with "${vault.gate.methodId}", which is not configured in this app.`, txHash: null });
                }
            } else {
                const { rows } = await protectAll(bindings.deps, { vault, gate, targets: resolved, onProgress: note });
                for (const row of rows) {
                    const target = targets.find((t) => t.chainId === row.chainId)!;
                    out.push(row.ok
                        ? { chainId: row.chainId, chainLabel: target.chainLabel, action: target.action, failure: null, txHash: row.result.tx?.hash ?? null }
                        : { chainId: row.chainId, chainLabel: target.chainLabel, action: target.action, failure: row.error, txHash: null });
                }
            }
            setResults([...out]);
            setRunning(false);
            setDone(true);
            await onDone?.();
        },
        [bindings, methods, onDone, vault, wallet],
    );

    return {
        running, log, results, done, run,
        reset: useCallback(() => { setLog([]); setResults([]); setDone(false); }, []),
    };
}
