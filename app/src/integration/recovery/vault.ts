/**
 * Seal and recover, with the bookkeeping that keeps a recovery honest.
 *
 * Three SDK calls do the work; everything else here exists because of what the SDK deliberately does
 * not do for you: it does not remember which guardians you named (the seal records domains only), it
 * does not record the epoch it derived under (that is not in the envelope), and it does not tell you
 * whether the key that came back is the key you registered. Those three are this file's job, and
 * getting any of them wrong fails silently.
 *
 * `sealVault` below is this app's operation, not the SDK's `ConditionAdapter.sealVault`. It is
 * `createVault()` — the paid ceremony, which yields an **empty** vault — followed immediately by one
 * `addChain()`. They are separate in the SDK so a wallet can set recovery up before the user holds
 * anything anywhere; this demo runs them together because it has an account in hand already, and
 * records the two timings apart so the asymmetry between them is visible rather than asserted.
 *
 * **To replace:** `VaultRecordStore` with wherever your wallet keeps metadata, and the `RecoverySDK`
 * construction if you bind one adapter for the life of the app. Split the two calls if your wallet
 * onboards before it has funds. Keep the order: ceremony, then record, then register on-chain — a
 * recovery key nothing has registered protects nothing.
 * **Assumes:** one vault per `vaultId`, and that the caller passes the same `ChainModule` at recovery
 * that it passed at seal time. The curve belongs to the chain, not to the SDK.
 */
import {
    RecoverySDK,
    type RecoveredAuthority,
    type SealBlob,
    type SealStore,
    type SealedDataStore,
    type SpentSeal,
} from "@nihilium/recovery-core";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ChainModule, DerivedAccount } from "../chains/types.js";
import type {
    GateRecord,
    RecoveryMethod,
    SubjectPhase,
    SubjectPrompt,
    Subject,
    SubjectSealed,
} from "../conditions/types.js";
import {
    assertRecoveredKeyMatches,
    chainContextOf,
    type VaultChainRecord,
    type VaultRecord,
    type VaultRecordStore,
} from "./vaultRecords.js";

export interface VaultDeps {
    sealStore: SealStore;
    dataStore: SealedDataStore;
    vaults: VaultRecordStore;
}

export interface SealVaultParams {
    method: RecoveryMethod;
    subjects: readonly Subject[];
    threshold: number;
    chain: ChainModule;
    account: DerivedAccount;
    vaultId: string;
    /** Bumped by a completed recovery. Seal against what the chain says *now*, and record it. */
    epoch?: number;
    onSubjectSealed?(event: SubjectSealed): void;
    onProgress?(message: string): void;
}

export interface SealVaultResult {
    vault: VaultRecord;
    /** Returned, never stored beside the record: the caller offers it as a download and drops it. */
    seal: SealBlob;
}

export async function sealVault(deps: VaultDeps, params: SealVaultParams): Promise<SealVaultResult> {
    const setup = await params.method.createSetup({
        subjects: params.subjects,
        threshold: params.threshold,
        ...(params.onSubjectSealed ? { onSubjectSealed: params.onSubjectSealed } : {}),
    });

    // Built per operation, not once for the app: the condition adapter is this gate's quorum, and a
    // long-lived SDK would be bound to whichever gate happened to be first.
    const sdk = new RecoverySDK({
        key: params.chain.keyAdapter,
        condition: setup.adapter,
        sealStore: deps.sealStore,
        dataStore: deps.dataStore,
    });

    const context = chainContextOf(
        { vaultId: params.vaultId },
        {
            namespace: params.chain.namespace,
            tier: params.chain.tier,
            accountId: params.account.accountId,
            epoch: params.epoch ?? 0,
        },
    );

    // Two calls, and the gap between their timings is the lesson. `createVault()` runs the ceremony:
    // paid, plural, online, and it produces an **empty** vault — no recovery key and no record,
    // because neither exists until a chain is in it.
    params.onProgress?.(`sealing ${params.threshold} of ${params.subjects.length}`);
    const ceremonyStart = performance.now();
    const created = await sdk.createVault({
        condition: setup.condition,
        // The compartment (§11). Every later `addChain()` and `recover()` for this vault must repeat
        // it: it is how the seal is filed and how a recovery finds it again.
        vaultId: params.vaultId,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
    const ceremonyMs = Math.round(performance.now() - ceremonyStart);

    // `addChain()` puts the first chain in. Free, offline, repeatable — and identical code to the
    // tenth chain, so the first cannot quietly acquire a property the rest lack.
    const writeStart = performance.now();
    const added = await sdk.addChain({ publicComponent: created.publicComponent, chain: context });
    const writeMs = Math.round(performance.now() - writeStart);
    params.onProgress?.(`addChain   ${params.chain.id} in ${writeMs} ms`);

    const chainRecord: VaultChainRecord = {
        chainId: params.chain.id,
        namespace: context.namespace,
        tier: context.tier,
        accountId: context.accountId,
        epoch: context.epoch,
        algorithm: params.chain.keyAdapter.algorithm,
        recoveryPubKeyHex: bytesToHex(added.recoveryPubKey.bytes),
        entryId: added.entry.entryId,
        addedAt: Date.now(),
        writeMs,
        // Sealed is not protected. Set once the chain has registered this key.
        settlement: null,
    };

    const vault: VaultRecord = {
        vaultId: params.vaultId,
        recordId: created.recordId,
        createdAt: Date.now(),
        ceremonyMs,
        // The annotated one `addChain()` returned, not the empty one the ceremony produced: it
        // carries the chains annotation every later `addChain()` builds on.
        publicComponent: added.publicComponent,
        gate: { ...setup.gate, summary: setup.condition.summary },
        chains: [chainRecord],
        spent: null,
    };
    await deps.vaults.put(vault);

    return { vault, seal: created.sealBlob };
}

/**
 * Forget a vault: its seal, then its ledger row.
 *
 * `RecoverySDK.discardSpentSeal()` is this `deleteSeal` call plus a guard that a seal store is
 * configured, and building an SDK to reach it needs a `ConditionAdapter` a deletion has no use for.
 * The ledger row is ours either way — the SDK does not know this record exists.
 */
export async function discardVault(deps: VaultDeps, vaultId: string): Promise<void> {
    await deps.sealStore.deleteSeal(vaultId);
    await deps.vaults.delete(vaultId);
}

/**
 * Replace a vault's gate with a new one: a fresh, paid ceremony under a **new `vaultId`**.
 *
 * The order is the whole safety argument. The new seal is bought and committed first, and only then
 * is the old one discarded — so a ceremony that dies at the second guardian leaves the previous gate
 * intact and still recoverable. Doing it the other way round has a window in which the user has no
 * recovery at all, and that window covers the slowest, most failure-prone step in the system.
 *
 * This is not a fix for a *spent* vault. A recovery exposed the root secret, so the same account
 * behind a new gate is still an account whose key someone else derived; the answer there is a new
 * account, not a new seal.
 */
export async function resealVault(
    deps: VaultDeps,
    params: SealVaultParams & { replacing: string },
): Promise<SealVaultResult> {
    if (params.replacing === params.vaultId) {
        throw new Error(
            `A re-seal must use a new vaultId: ${params.vaultId} is an HKDF input, so re-using it ` +
                "would derive the same recovery key behind the new gate and overwrite the old seal.",
        );
    }
    const result = await sealVault(deps, params);
    await discardVault(deps, params.replacing);
    params.onProgress?.(`discard     ${params.replacing} — replaced by ${params.vaultId}`);
    return result;
}

export interface RecoverVaultParams {
    method: RecoveryMethod;
    gate: GateRecord;
    /** Exactly `gate.threshold` 1-based indices. Checked here and again by the method. */
    selected: readonly number[];
    chain: ChainModule;
    vault: VaultRecord;
    /** The chain being recovered — a vault may protect several. */
    chainRecord: VaultChainRecord;
    /** From an imported file. Absent, the seal store is asked. */
    seal?: SealBlob;
    /** From a provider, when this browser holds no records of its own. */
    entries?: VaultRecord extends never ? never : Parameters<RecoverySDK["recover"]>[0]["entries"];
    onProgress?(message: string): void;
    onSubjectProgress?(index: number, message: string): void;
    onSubjectPhase?(index: number, phase: SubjectPhase): void;
    onSubjectPrompt?(prompt: SubjectPrompt): void;
}

export interface RecoverVaultResult {
    authority: RecoveredAuthority;
    spent: SpentSeal;
    contacted: readonly number[];
    /** Guardians this recovery never asked. Rendered as prominently as the ones it did. */
    untouched: readonly number[];
}

export async function recoverVault(
    deps: VaultDeps,
    params: RecoverVaultParams,
): Promise<RecoverVaultResult> {
    const recovery = await params.method.createRecovery({
        gate: params.gate,
        selected: params.selected,
        ...(params.onSubjectProgress ? { onSubjectProgress: params.onSubjectProgress } : {}),
        ...(params.onSubjectPhase ? { onSubjectPhase: params.onSubjectPhase } : {}),
        ...(params.onSubjectPrompt ? { onSubjectPrompt: params.onSubjectPrompt } : {}),
    });

    const sdk = new RecoverySDK({
        key: params.chain.keyAdapter,
        condition: recovery.adapter,
        sealStore: deps.sealStore,
        dataStore: deps.dataStore,
    });

    const context = chainContextOf(params.vault, params.chainRecord);
    const outcome = await sdk.recover({
        proof: recovery.proof,
        chain: context,
        ...(params.seal ? { seal: params.seal } : {}),
        ...(params.entries ? { entries: params.entries } : {}),
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });

    // The only check that catches a wrong epoch, and necessarily after the ceremony has run.
    assertRecoveredKeyMatches(outcome.authority, params.chainRecord);

    // A spent vault is never silently reused: every chain's root secret is now exposed to whoever
    // ran this, and the answer is a new ceremony, never a new epoch on the old one.
    await deps.vaults.put({
        ...params.vault,
        spent: { at: Date.now(), reason: outcome.spent.reason },
    });

    return {
        authority: outcome.authority,
        spent: outcome.spent,
        contacted: recovery.contacted,
        untouched: recovery.untouched,
    };
}
