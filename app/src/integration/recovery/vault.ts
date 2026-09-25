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
 * **Recovery is not here.** It lives in `recoverAll.ts`, which opens *every* chain a vault covers
 * from one ceremony. A single-chain `recoverVault()` used to sit in this file and was deleted rather
 * than kept as a convenience: it is the shape a reader would copy, and it emails every guardian once
 * per chain — undoing `addChain()`'s whole argument at the one moment it costs real money.
 *
 * **To replace:** `VaultRecordStore` with wherever your wallet keeps metadata, and the `RecoverySDK`
 * construction if you bind one adapter for the life of the app. Split the two calls if your wallet
 * onboards before it has funds. Keep the order: ceremony, then record, then register on-chain — a
 * recovery key nothing has registered protects nothing.
 * **Assumes:** one vault per `vaultId`, and that the caller passes the same `ChainModule` at recovery
 * that it passed at seal time. The curve belongs to the chain, not to the SDK.
 */
import {
    OneWayViolationError,
    RecoverySDK,
    type RecoveryKeyInput,
    type SealBlob,
    type SealStore,
    type SealedDataStore,
} from "@nihilium/recovery-core";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ChainModule, DerivedAccount } from "../chains/types.js";
import { toSealFile, type SealFile } from "./sealFile.js";
import { pullVaultFromHost, type RecordHost } from "./recordHost.js";
import type {
    RecoveryMethod,
    Subject,
    SubjectSealed,
} from "../conditions/types.js";
import {
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
    /** The wallet this vault belongs to. See `VaultRecord.walletId` for why it is not an address. */
    walletId: string;
    /** Bumped by a completed recovery. Seal against what the chain says *now*, and record it. */
    epoch?: number;
    /** Recorded on the vault and used by every later protect. See `VaultRecord.timelockSeconds`. */
    timelockSeconds?: number;
    /** Where this vault's records are replicated. Written into the seal file. */
    recordHosts?: readonly string[];
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
        // So a recovery run from a different seed can still rebuild this chain's addresses. See
        // `VaultChainRecord.signerAddress` for why the PDA alone is not enough on Solana.
        signerAddress: params.account.signer.address,
    };

    const vault: VaultRecord = {
        vaultId: params.vaultId,
        walletId: params.walletId,
        recordId: created.recordId,
        createdAt: Date.now(),
        ceremonyMs,
        // The annotated one `addChain()` returned, not the empty one the ceremony produced: it
        // carries the chains annotation every later `addChain()` builds on.
        publicComponent: added.publicComponent,
        gate: { ...setup.gate, summary: setup.condition.summary },
        chains: [chainRecord],
        spent: null,
        ...(params.timelockSeconds !== undefined ? { timelockSeconds: params.timelockSeconds } : {}),
        ...(params.recordHosts !== undefined ? { recordHosts: params.recordHosts } : {}),
    };
    await deps.vaults.put(vault);

    return { vault, seal: created.sealBlob };
}

export interface AddChainParams {
    method: RecoveryMethod;
    vault: VaultRecord;
    chain: ChainModule;
    account: DerivedAccount;
    /** Bumped by a completed recovery on *that* chain. Seal against what this chain says now. */
    epoch?: number;
    /**
     * Bring your own root, so this chain's recovery key can be *used* and not merely recorded.
     *
     * Omitted, the SDK mints a root, derives the public half and wipes the rest — which is what you
     * want everywhere the chain only needs to be told an address. Solana's `register` makes the
     * incoming guardian sign a digest, so there the caller must hold the root long enough to
     * produce one signature. It is never persisted; see `protectOnSolana`.
     */
    recoveryKey?: RecoveryKeyInput;
    /**
     * Mint a fresh key for a chain already in this vault, replacing its record.
     *
     * Not a way around the duplicate guard: two roots for one chain in one vault would leave a
     * recovery with no way to say which is current, and that is still refused. This *replaces* the
     * record, so there is exactly one key per chain either way.
     */
    rekey?: boolean;
    onProgress?(message: string): void;
}

/**
 * Put another chain into a vault that already exists.
 *
 * **This is free, and the gap between it and `sealVault` is the whole point.** A ceremony is paid,
 * plural, online and slow; this is one local encryption against a public key the vault already
 * published, and it contacts nobody. A wallet that made its user buy a ceremony per chain would be
 * charging them for the SDK's cheapest operation.
 *
 * The gate does not change and is not re-run: the same guardians that opened the first chain open
 * this one, because it is the same vault. What changes is that one more record sits inside it — and
 * that is also the cost, stated plainly: a recovery opens *every* chain in the vault, so adding one
 * widens what a single ceremony exposes.
 *
 * **To replace:** nothing. **Assumes:** `vault.publicComponent` is the annotated one the last
 * `addChain()` returned, not the empty one the ceremony produced — this function keeps that true by
 * writing the new annotation back.
 */
export async function addChainToVault(
    deps: VaultDeps,
    params: AddChainParams,
): Promise<VaultRecord> {
    const existing = params.vault.chains.find((row) => row.chainId === params.chain.id);
    if (existing !== undefined && params.rekey === true) {
        // Re-keying, not double-adding. A chain whose root the app did not keep cannot produce the
        // registration signature its settlement needs, and minting a fresh root for that chain is
        // the only way to get one. The superseded entry stays in the record — the store is
        // append-only — and the vault record points at the new key, which is what a recovery reads.
        params.onProgress?.(
            `addChain   re-keying ${params.chain.id}; the previous recovery key for this chain is superseded`,
        );
    } else if (existing !== undefined) {
        // A second root secret for one chain would leave a recovery unable to say which is current.
        throw new Error(
            `${params.chain.label} is already in vault ${params.vault.vaultId}.`,
        );
    }

    // The curve belongs to the chain, and the adapter to the gate. Neither is the "app's" — a vault
    // holding an ed25519 chain beside a secp256k1 one is the normal case, not a special one.
    const sdk = new RecoverySDK({
        key: params.chain.keyAdapter,
        condition: params.method.appendAdapter(params.vault.gate),
        sealStore: deps.sealStore,
        dataStore: deps.dataStore,
    });

    const context = chainContextOf(params.vault, {
        namespace: params.chain.namespace,
        tier: params.chain.tier,
        // Straight from the chain module, on every chain. Solana used to need a chain read here —
        // its vault address depended on the SDK's vault id, so it could not be known until one
        // existed. With that dependency gone the address is a function of the seed, exactly like
        // the counterfactual smart-account address on EVM, and there is nothing to wait for.
        accountId: params.account.accountId,
        epoch: params.epoch ?? 0,
    });

    const startedAt = performance.now();
    const added = await sdk.addChain({
        publicComponent: params.vault.publicComponent,
        chain: context,
        // A caller-supplied root is how a chain that must *sign* its own registration gets a key it
        // can sign with: the SDK would otherwise mint and wipe the root internally, leaving only a
        // public half. The caller holds it for one signature and zeroes it — see `protectOnSolana`.
        ...(params.recoveryKey ? { recoveryKey: params.recoveryKey } : {}),
    });
    const writeMs = Math.round(performance.now() - startedAt);
    params.onProgress?.(`addChain   ${params.chain.id} in ${writeMs} ms · no ceremony, no payment`);

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
        // Sealed is not protected — on this chain as on the first.
        settlement: null,
        signerAddress: params.account.signer.address,
    };

    const updated: VaultRecord = {
        ...params.vault,
        chains: [
            ...params.vault.chains.filter((row) => row.chainId !== params.chain.id),
            chainRecord,
        ],
        // The annotation grows with each chain, so the next `addChain()` builds on this one.
        publicComponent: added.publicComponent,
    };
    await deps.vaults.put(updated);
    return updated;
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
        // vaultId is an HKDF input: reusing it derives the same recovery key behind the new gate
        // and overwrites the old seal.
        throw new Error(
            `A re-seal needs a new vaultId; ${params.vaultId} is already used.`,
        );
    }
    const result = await sealVault(deps, params);
    await discardVault(deps, params.replacing);
    params.onProgress?.(`discard     ${params.replacing} — replaced by ${params.vaultId}`);
    return result;
}

/**
 * The wallet a vault belongs to, when the file cannot say.
 *
 * An imported seal file carries the vault and the gate, never the seed — so this browser genuinely
 * does not know whose wallet it protects, and cannot derive it. Marking it with a value no seed
 * fingerprint can equal is the honest answer, and it sorts the vault under "seed gone", which is
 * both true from here and the group that needs the attention.
 */
export const IMPORTED_WALLET_ID = "imported — seed unknown";

/**
 * Take a seal file and make this browser able to open the vault it describes.
 *
 * Three writes, and the order is the safety argument: the seal last, because it is the bearer half
 * and a half-finished import that left a seal with no context is the one state that looks recoverable
 * and is not.
 *
 * **Idempotent by construction.** Records are append-only and reject a duplicate `entryId` with
 * `OneWayViolationError` — which here is not a failure but the expected answer for a file imported
 * twice, so it is swallowed per entry rather than aborting the import.
 *
 * **To replace:** nothing, if you keep this file format. A wallet that fetches records from a host
 * imports the seal alone and lets the host supply the rest. **Assumes:** the caller has already
 * parsed and validated the file with `parseSealFile`.
 */
export async function importSealFile(
    deps: VaultDeps,
    file: SealFile,
): Promise<{ vault: VaultRecord; entriesAdded: number; entriesAlreadyHeld: number }> {
    const existing = await deps.vaults.get(file.vaultId);

    let added = 0;
    let held = 0;
    for (const entry of file.entries ?? []) {
        try {
            await deps.dataStore.addEntry(file.recordId as VaultRecord["recordId"], entry);
            added += 1;
        } catch (error) {
            // Already here. The store is append-only and says so by refusing; for an import that is
            // the success case, not an error.
            if (error instanceof OneWayViolationError) held += 1;
            else throw error;
        }
    }

    // The ledger row, kept if one already exists: a local record may carry settlement state and an
    // epoch this file predates, and overwriting that with the file's older view would be a silent
    // downgrade of the one field nothing else can check.
    const vault: VaultRecord = existing ?? {
        vaultId: file.vaultId,
        walletId: IMPORTED_WALLET_ID,
        recordId: file.recordId as VaultRecord["recordId"],
        createdAt: file.exportedAt,
        ceremonyMs: 0,
        publicComponent: file.publicComponent,
        gate: file.gate,
        chains: file.chains,
        spent: null,
        ...(file.recordHosts !== undefined ? { recordHosts: file.recordHosts } : {}),
    };
    if (existing === undefined) await deps.vaults.put(vault);

    // Last. See above.
    await deps.sealStore.putSeal(file.vaultId, file.seal);
    return { vault, entriesAdded: added, entriesAlreadyHeld: held };
}

/**
 * The seal file for a vault, from storage.
 *
 * Only the seal and the instructions — the records and every chain's context are on the record
 * host, which is why a file downloaded once does not go stale when a chain is added. Built from the
 * stored vault anyway, so the chains it lists for the pre-ceremony check are today's.
 */
export async function exportSealFile(deps: VaultDeps, vaultId: string): Promise<SealFile> {
    const vault = await deps.vaults.get(vaultId);
    if (vault === undefined) throw new Error(`No vault ${vaultId} in this browser.`);
    return toSealFile(vault, await deps.sealStore.getSeal(vaultId));
}

/**
 * Pull the host's records and chain contexts into this device, and save the vault if it grew.
 *
 * Run before a recovery: it is how a chain protected after the seal file was saved gets into the
 * vault this device recovers from.
 */
export async function refreshVaultFromHost(
    deps: VaultDeps,
    host: RecordHost,
    vault: VaultRecord,
): Promise<{ vault: VaultRecord; recordsAdded: number; chainsAdded: string[] }> {
    const pulled = await pullVaultFromHost(deps.dataStore, host, vault);
    if (pulled.vault !== vault) {
        // Re-read and merge onto the stored row, so a `spent` mark written meanwhile is not lost.
        const stored = (await deps.vaults.get(vault.vaultId)) ?? vault;
        const updated = { ...stored, chains: pulled.vault.chains };
        await deps.vaults.put(updated);
        return { ...pulled, vault: updated };
    }
    return pulled;
}
