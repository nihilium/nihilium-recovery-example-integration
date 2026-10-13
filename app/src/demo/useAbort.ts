/**
 * Killing a recovery, as the owner.
 *
 * **Driven from the vault, not from the handover rows.** An attempt exists on-chain whether or not
 * this browser has a record of it, and that is precisely the case abort exists for.
 *
 * **The authority is the wallet's own key.** `abort` checks the sender, so the relayer cannot help:
 * the key signs and pays for itself. On Sepolia that key is the Safe's owner EOA, which usually
 * holds nothing — so the demo tops it up from the relayer's capped faucet first. In the true
 * seed-loss case the key is gone, and so is abort; `canAbort` reports it rather than hiding the button.
 */
import { useCallback, useState } from "react";
import { abortRecoveries, readProtection, type VaultRecord } from "@nihilium/recovery-sdk";
import { deriveWallet } from "./wallet.js";
import { seedFingerprint, type SeedBook } from "./seeds.js";
import type { AppBindings } from "../wiring.js";

export interface AbortOutcome {
    chainId: string;
    hash: string | null;
    failure: string | null;
}

/** 0.001 ETH: below this an abort cannot pay for itself; 0.002 ETH is what the faucet sends. */
const ABORT_GAS_FLOOR_WEI = 1_000_000_000_000_000n;
const ABORT_TOP_UP_WEI = 2_000_000_000_000_000n;

export function useAbort(bindings: AppBindings, seeds: SeedBook) {
    const [running, setRunning] = useState(false);
    const [log, setLog] = useState<readonly string[]>([]);
    const [outcomes, setOutcomes] = useState<readonly AbortOutcome[]>([]);

    /** Whether this browser still holds the seed the vault's abort authority is derived from. */
    const canAbort = useCallback(
        (vault: VaultRecord | null) => vault !== null && seeds.seeds.some((entry) => seedFingerprint(entry.mnemonic) === vault.walletId),
        [seeds.seeds],
    );

    const abort = useCallback(
        async (vault: VaultRecord) => {
            const seed = seeds.seeds.find((entry) => seedFingerprint(entry.mnemonic) === vault.walletId);
            if (seed === undefined) return;
            setRunning(true);
            setOutcomes([]);
            setLog([]);
            const note = (line: string) => setLog((prev) => [...prev, line]);

            try {
                // The vault's own wallet, not the active one. Abort is the owner's power.
                const owner = await deriveWallet(bindings.chains, seed.mnemonic);
                const results: AbortOutcome[] = [];
                const targets = [];

                for (const record of vault.chains) {
                    const chain = bindings.chains.get(record.chainId);
                    const account = owner.accounts[record.chainId]?.[0];
                    if (chain === undefined || chain.settlement === null || account === undefined) {
                        results.push({ chainId: record.chainId, hash: null, failure: "No settlement is wired for this chain in this build." });
                        continue;
                    }
                    // Only where something is in flight: abort on a chain with no attempt reverts.
                    const state = await readProtection({ chain, account: { accountId: record.accountId, ...(record.signerAddress ? { signerAddress: record.signerAddress } : {}) }, vault }).catch(() => null);
                    if (state === null || (state.attempt !== "INITIATED" && state.attempt !== "PAUSED")) {
                        note(`abort      ${record.chainId} — nothing in flight`);
                        results.push({ chainId: record.chainId, hash: null, failure: null });
                        continue;
                    }
                    // EVM only: the key pays its own gas and the Safe's owner holds none. The top-up
                    // authorises nothing; the abort is still the key's own transaction.
                    if (chain.namespace.startsWith("eip155:")) {
                        const balance = (await chain.balanceOf(account.signer.address)).raw;
                        if (balance < ABORT_GAS_FLOOR_WEI) {
                            note(`fund       ${ABORT_TOP_UP_WEI} wei from the relayer — the abort key has no gas of its own`);
                            await bindings.relay.fund(chain.namespace, account.signer.address, ABORT_TOP_UP_WEI);
                        }
                    }
                    targets.push({ chain, account: { accountId: record.accountId, ...(record.signerAddress ? { signerAddress: record.signerAddress } : {}) }, authority: await account.signer.keyExecutor() });
                }

                for (const row of await abortRecoveries({ targets, onProgress: note })) {
                    results.push(row.ok ? { chainId: row.chainId, hash: row.hash, failure: null } : { chainId: row.chainId, hash: null, failure: row.error });
                    if (!row.ok) note(`abort      ${row.chainId} ✗ ${row.error}`);
                }
                setOutcomes(results);

                // The rows are the only record of an intent, and an aborted attempt can never be
                // executed. Only for chains that are now clear.
                const clear = new Set(results.filter((row) => row.failure === null).map((row) => row.chainId));
                for (const row of await bindings.deps.handovers.forVault(vault.vaultId)) {
                    if (clear.has(row.chainId)) await bindings.deps.handovers.delete(row.id);
                }
            } finally {
                setRunning(false);
            }
        },
        [bindings, seeds.seeds],
    );

    return { abort, canAbort, running, log, outcomes };
}

export type Abort = ReturnType<typeof useAbort>;
