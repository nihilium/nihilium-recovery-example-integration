/**
 * Recover **every** chain a vault covers, from one ceremony.
 *
 * This is the operation this repo exists to demonstrate. A vault is one gate over many chains: the
 * ceremony is paid, plural and slow, and `addChain()` is free — so a recovery that charged a
 * ceremony per chain would undo the whole asymmetry at the one moment it matters most. `recover()`
 * returns one chain's authority per call, so the batching happens in `oneCeremony.ts`, which makes
 * the ceremony idempotent and leaves every SDK guarantee intact.
 *
 * **A failed chain is a row, not a throw.** A vault may hold a chain this build has no key adapter
 * for, or one whose epoch drifted. Losing the other chains' keys because of it would mean paying for
 * a second ceremony to get them — so each chain reports its own outcome and the caller renders both.
 *
 * **Every chain is checked separately.** `assertRecoveredKeyMatches` is the only thing that catches
 * a wrong epoch, which is an HKDF input the envelope does not carry: a wrong one yields a different,
 * perfectly valid key for an account that has never heard of it. Checking once and assuming the rest
 * would be checking nothing — and here it is also what would catch an adapter whose `openRecords`
 * varied by chain, which `oneCeremony.ts` assumes does not happen.
 *
 * **To replace:** the `chains` registry lookup, if your wallet resolves key adapters another way.
 * Keep the shape: one ceremony, n keys, per-chain verification, and a wipe that always runs.
 * **Assumes:** `vault.chains` is the whole vault. A chain added but not recorded here is a chain
 * whose key this never derives — and nothing would report it missing.
 */
import {
    RecoverySDK,
    type SealBlob,
    type SealedDataEntry,
    type SpentSeal,
} from "@nihilium/recovery-core";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ChainRegistry } from "../chains/types.js";
import type { GateRecord, RecoveryMethod, SubjectPhase, SubjectPrompt } from "../conditions/types.js";
import { shareOneCeremony } from "./oneCeremony.js";
import {
    assertRecoveredKeyMatches,
    chainContextOf,
    recoveredPublicKey,
    type VaultChainRecord,
    type VaultRecord,
} from "./vaultRecords.js";
import type { VaultDeps } from "./vault.js";

export interface RecoveredChainKey {
    chainId: string;
    chainLabel: string;
    chainRecord: VaultChainRecord;
    /** `null` when this chain failed; `failure` then says why. */
    publicKeyHex: string | null;
    /**
     * The chain-native address, via `ChainModule.addressOfPublicKey`. `null` where the chain has no
     * such concept, or where this chain failed.
     */
    address: string | null;
    /**
     * The private half, in `rawKey` mode. Held so the demo can show it and sign the on-chain
     * handover with it, and zeroized by `wipe()`. A production wallet takes the capability instead
     * and lets it zeroize itself — see `vault.ts`.
     */
    material: Uint8Array | null;
    /** Why this chain produced no key. `null` on success. */
    failure: string | null;
}

export interface RecoverAllResult {
    keys: readonly RecoveredChainKey[];
    /** The SDK's own sentence, verbatim. `null` only if every chain failed before opening anything. */
    spent: SpentSeal | null;
    contacted: readonly number[];
    /** Guardians this recovery never asked. Rendered as prominently as the ones it did. */
    untouched: readonly number[];
    /** How many times the guardians were actually asked. One, for any number of chains. */
    ceremonies: number;
    /** Zeroize every recovered key. The caller runs this when it is done with them. */
    wipe(): void;
}

export interface RecoverAllParams {
    method: RecoveryMethod;
    gate: GateRecord;
    /** Exactly `gate.threshold` 1-based indices. Checked here and again by the method. */
    selected: readonly number[];
    vault: VaultRecord;
    chains: ChainRegistry;
    /** From an imported file. Absent, the seal store is asked. */
    seal?: SealBlob;
    /** From a provider or an imported file, when this browser holds no records of its own. */
    entries?: readonly SealedDataEntry[];
    onProgress?(message: string): void;
    onSubjectProgress?(index: number, message: string): void;
    onSubjectPhase?(index: number, phase: SubjectPhase): void;
    onSubjectPrompt?(prompt: SubjectPrompt): void;
}

export async function recoverAllChains(
    deps: VaultDeps,
    params: RecoverAllParams,
): Promise<RecoverAllResult> {
    const recovery = await params.method.createRecovery({
        gate: params.gate,
        selected: params.selected,
        ...(params.onSubjectProgress ? { onSubjectProgress: params.onSubjectProgress } : {}),
        ...(params.onSubjectPhase ? { onSubjectPhase: params.onSubjectPhase } : {}),
        ...(params.onSubjectPrompt ? { onSubjectPrompt: params.onSubjectPrompt } : {}),
    });

    // Loaded once rather than per chain. The SDK would fetch them again on every `recover()`, which
    // is free against IndexedDB and is n round trips against a record host.
    const entries = params.entries ?? (await deps.dataStore.getEntries(params.vault.recordId));

    const shared = shareOneCeremony(recovery.adapter);
    const keys: RecoveredChainKey[] = [];
    let spent: SpentSeal | null = null;

    try {
        for (const chainRecord of params.vault.chains) {
            const chain = params.chains.get(chainRecord.chainId);
            const chainLabel = chain?.label ?? chainRecord.chainId;
            const blank = {
                chainId: chainRecord.chainId,
                chainLabel,
                chainRecord,
                publicKeyHex: null,
                address: null,
                material: null,
            };

            if (chain === undefined) {
                // A vault outliving a chain this build dropped. The other chains still recover, and
                // saying so beats a thrown error that loses them.
                keys.push({
                    ...blank,
                    failure:
                        // The key's curve belongs to the chain module, so without one it cannot be derived.
                        `No chain module for "${chainRecord.chainId}" in this build. Other chains are unaffected.`,
                });
                continue;
            }

            try {
                // A new SDK per chain, because the key adapter is the chain's. The condition adapter
                // is the shared one, which is what keeps this to a single ceremony.
                const sdk = new RecoverySDK({
                    key: chain.keyAdapter,
                    condition: shared.adapter,
                    sealStore: deps.sealStore,
                    dataStore: deps.dataStore,
                });

                const outcome = await sdk.recover({
                    proof: recovery.proof,
                    chain: chainContextOf(params.vault, chainRecord),
                    // `rawKey` — the SDK's first-class opt-out (§13). The demo has to show what came
                    // out and sign the on-chain handover with it; see `vault.ts` for the trade.
                    options: { mode: "rawKey" },
                    entries,
                    ...(params.seal ? { seal: params.seal } : {}),
                    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
                });

                // Per chain, and never once for the vault. See the header.
                assertRecoveredKeyMatches(outcome.authority, chainRecord, chain.keyAdapter);

                // Derived once, through the chain's own adapter, so no caller re-derives it with
                // the wrong curve — an ed25519 point from secp256k1 bytes does not fail, it yields
                // a different key that matches nothing.
                const publicKey = recoveredPublicKey(outcome.authority, chain.keyAdapter);
                const publicKeyHex = bytesToHex(publicKey.bytes);
                spent ??= outcome.spent;
                keys.push({
                    ...blank,
                    publicKeyHex,
                    address: chain.addressOfPublicKey(publicKey),
                    material:
                        outcome.authority.kind === "rawKey" ? outcome.authority.material : null,
                    failure: null,
                });
                params.onProgress?.(`recover     ${chainRecord.chainId} ✓ ${publicKeyHex.slice(0, 18)}…`);
            } catch (error) {
                const failure = error instanceof Error ? error.message : String(error);
                keys.push({ ...blank, failure });
                params.onProgress?.(`recover     ${chainRecord.chainId} ✗ ${failure}`);
            }
        }
    } finally {
        // Always. The shared plaintexts are every chain's root secret, held for the whole loop
        // rather than for one call — which is what buying a single ceremony costs.
        shared.wipe();
    }

    return {
        keys,
        spent,
        contacted: recovery.contacted,
        untouched: recovery.untouched,
        ceremonies: shared.ceremonies(),
        wipe() {
            for (const key of keys) key.material?.fill(0);
        },
    };
}
