/**
 * Watching a vault: build its watch registration, keep it registered, and read what it says.
 *
 * A watch has two halves, and they come from two places:
 *
 * - **Off-chain targets** come from the condition adapter's `watchTargets(publicComponent)`, through
 *   `RecoverySDK.buildWatchRegistration`. They watch the unsealing itself: the reveal values a
 *   Nihilium unseal publishes before any proof, so an alarm fires while a hostile recovery is still
 *   in the ceremony.
 * - **On-chain targets** are built here, one per chain this vault protects right now, from what the
 *   chain holds: the registered recovery owner and the epoch. They are only knowable after a
 *   protect, which is why registration has to be re-done as chains are protected.
 *
 * **Re-registering replaces.** A watch's targets are fixed at registration, so a changed chain set is
 * a new watch, and the old one is unregistered with its manage credential. Target ids are
 * deterministic, so an unchanged set is a no-op and this can run on every reload.
 *
 * **Unknown is never "watching".** `watchView` maps every state the SDK cannot vouch for (never
 * polled, degraded, suspended, unreachable) to `unknown`, and only a healthy watch with no alarm to
 * `watching`.
 *
 * **To replace:** the registration credential, which a real operator issues per tenant, and the
 * choice to register automatically. The SDK treats watching as opt-in, with a privacy price (see
 * `server/src/roles/watchtower`), and a production wallet asks first. **Assumes:** `chains` are read
 * this session. A remembered read would register expectations the chain no longer holds.
 */
import {
    RecoverySDK,
    type KeyAdapter,
    type SealStore,
    type SealedDataStore,
    type WatchRegistration,
    type WatchStatus,
    type WatchTarget,
    type WatchtowerClient,
} from "@nihilium/recovery-core";
import { evmRecoveryTarget } from "@nihilium/recovery-watchtower-evm";
import { solanaRecoveryTarget } from "@nihilium/recovery-watchtower-solana";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import type { RecoveryMethod } from "../conditions/types.js";
import type { VaultChainRecord, VaultRecord } from "./vaultRecords.js";
import type { OnChainState } from "./settlement/protect.js";

/** What this device keeps about a vault's watch. The manage credential is shown once, ever. */
export interface WatchRecord {
    url: string;
    watchId: string;
    manageCredential: string;
    targetIds: string[];
    registeredAt: number;
}

/** One vault chain, as read this session. `onchain` is `null` where the read failed. */
export interface ChainWatchInput {
    record: VaultChainRecord;
    label: string;
    onchain: OnChainState | null;
    /** Solana only: the vault PDA and its program, which the probe reads. */
    solana?: { vault: string; programId: string };
}

export interface UnwatchedChain {
    chainId: string;
    label: string;
    reason: string;
}

export interface VaultWatchPlan {
    registration: WatchRegistration;
    /** Chains with no on-chain target, and why. Rendered, never dropped. */
    unwatched: UnwatchedChain[];
    /**
     * True when a chain could not be read. The caller keeps the current watch rather than
     * re-registering without it: an RPC hiccup must not quietly remove a chain from the watch.
     */
    incomplete: boolean;
}

export interface BuildVaultWatchParams {
    vault: VaultRecord;
    method: RecoveryMethod;
    /** Any of the vault's key adapters. The SDK needs one to exist; building a registration never signs. */
    keyAdapter: KeyAdapter;
    stores: { sealStore: SealStore; dataStore: SealedDataStore };
    chains: readonly ChainWatchInput[];
}

export function buildVaultWatch(params: BuildVaultWatchParams): VaultWatchPlan {
    const additional: WatchTarget[] = [];
    const unwatched: UnwatchedChain[] = [];
    let incomplete = false;

    for (const chain of params.chains) {
        const skip = (reason: string) =>
            unwatched.push({ chainId: chain.record.chainId, label: chain.label, reason });
        const onchain = chain.onchain;
        if (onchain === null) {
            incomplete = true;
            skip("could not be read");
            continue;
        }
        if (!onchain.installed || !onchain.matchesVault || onchain.recoveryOwner === null) {
            skip("not protected yet");
            continue;
        }
        const target = onChainTarget(chain, onchain);
        if (target === null) skip("not watched on-chain");
        else additional.push(target);
    }

    // Built per call, like every other SDK use here: the condition adapter is this gate's.
    const sdk = new RecoverySDK({
        key: params.keyAdapter,
        condition: params.method.appendAdapter(params.vault.gate),
        sealStore: params.stores.sealStore,
        dataStore: params.stores.dataStore,
    });
    const registration = sdk.buildWatchRegistration({
        publicComponent: params.vault.publicComponent,
        additional,
        label: `vault ${params.vault.vaultId}`,
    });
    return { registration, unwatched, incomplete };
}

/**
 * The on-chain target for one protected chain, or `null` where no probe reads its settlement.
 *
 * Arbitrum's 7702 account is that case: the SDK's EVM probe calls the module's `stateOf(account)`,
 * and the 7702 account's views take no argument. See docs/sdk-proposals.md §5.
 */
function onChainTarget(chain: ChainWatchInput, onchain: OnChainState): WatchTarget | null {
    const { record } = chain;
    if (record.chainId === "evm-sepolia" && onchain.epoch !== null) {
        const chainId = Number(record.namespace.split(":")[1]);
        return evmRecoveryTarget({
            namespace: record.namespace,
            accountId: record.accountId,
            // From the address book, never defaulted: a wrong module reads as "nothing happened".
            module: recoveryModuleAddress(chainId),
            expectedRecoveryOwner: onchain.recoveryOwner!,
            expectedEpoch: onchain.epoch,
        });
    }
    if (
        record.chainId === "solana-devnet" &&
        chain.solana !== undefined &&
        onchain.epoch !== null &&
        onchain.configNonce !== null
    ) {
        return solanaRecoveryTarget({
            namespace: record.namespace,
            vault: chain.solana.vault,
            programId: chain.solana.programId,
            expectedRecoveryOwner: onchain.recoveryOwner!,
            expectedEpoch: onchain.epoch,
            expectedConfigNonce: onchain.configNonce,
        });
    }
    return null;
}

export function targetIdsOf(registration: WatchRegistration): string[] {
    return registration.targets.map((target) => target.targetId).sort();
}

/**
 * Keep the vault's watch equal to `registration`. Returns the record to store, and whether it changed.
 *
 * Registers first and unregisters second: in between there are two watches, never none.
 */
export async function syncVaultWatch(params: {
    client: WatchtowerClient;
    url: string;
    credential: string;
    current: WatchRecord | undefined;
    registration: WatchRegistration;
    now?: number;
}): Promise<{ record: WatchRecord; changed: boolean }> {
    const wanted = targetIdsOf(params.registration);
    const current = params.current;
    if (
        current !== undefined &&
        current.url === params.url &&
        current.targetIds.length === wanted.length &&
        current.targetIds.every((id, i) => id === wanted[i])
    ) {
        return { record: current, changed: false };
    }

    const registered = await params.client.register(params.registration, params.credential);
    const record: WatchRecord = {
        url: params.url,
        watchId: registered.watchId,
        manageCredential: registered.manageCredential,
        targetIds: wanted,
        registeredAt: params.now ?? Math.floor(Date.now() / 1000),
    };
    if (current !== undefined && current.url === params.url) {
        // Best effort. A watch left behind costs the operator a row; it never makes the new one wrong.
        await params.client.unregister(current.watchId, current.manageCredential).catch(() => undefined);
    }
    return { record, changed: true };
}

export type WatchView =
    | { state: "off"; message: string }
    | { state: "watching"; message: string; status: WatchStatus }
    | {
          state: "alarm";
          message: string;
          status: WatchStatus;
          /** Unix seconds. Absent while the attempt is off-chain only. */
          actBefore?: number;
          /** Whether any tripped target is on a chain, which is when abort can act. */
          onchain: boolean;
      }
    | { state: "unknown"; message: string; status?: WatchStatus };

/** Kinds whose targets are chains. Anything else is the off-chain plane. */
const OFF_CHAIN_KINDS = new Set(["nihilium-reveal"]);

export function watchView(input: { status: WatchStatus } | { error: unknown } | null): WatchView {
    if (input === null) return { state: "off", message: "not registered" };
    if ("error" in input) {
        const detail = input.error instanceof Error ? input.error.message : String(input.error);
        return { state: "unknown", message: `the watchtower could not be asked: ${detail}` };
    }
    const { status } = input;
    if (status.alarm === "attempt-detected") {
        const onchain = status.targets.some(
            (target) => target.verdict === "tripped" && !OFF_CHAIN_KINDS.has(target.kind),
        );
        return {
            state: "alarm",
            message: status.summary,
            status,
            onchain,
            ...(status.actBefore !== undefined ? { actBefore: status.actBefore } : {}),
        };
    }
    if (status.alarm === "none" && status.health.state === "watching") {
        return { state: "watching", message: status.summary, status };
    }
    // `alarm: "unknown"`, or a health state the SDK will not vouch for. Never rendered as watching.
    return { state: "unknown", message: status.summary, status };
}
