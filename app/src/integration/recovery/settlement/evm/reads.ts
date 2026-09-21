/**
 * Everything this app reads from the deployed `RecoveryModule`, behind one narrow interface.
 *
 * The interface exists so `preflight.ts` and `intent.ts` can be tested without a chain, but it earns
 * its place for a second reason: it is the only door to the module's views, so the rule below has
 * exactly one place to be broken.
 *
 * **The rule: never compute an intent or resume digest locally.** The module's EIP-712 domain
 * separator is built from `version()`, and the Sepolia deployment answers `"2.0.0"` while the
 * Solidity in `../recovery-sdk/onchain/evm` answers `"3.0.0"`. The structs are identical — the 7702
 * change left `Intent`, `onInstall` and `GradualVeto.Config` untouched — so the generated ABI
 * decodes against the deployment perfectly. The *digests* differ. A locally derived hash would be a
 * signature over a message the contract has never heard of, and it would fail at `initiateRecovery`
 * with a bad-signature error that points nowhere near the cause.
 *
 * **To replace:** the viem implementation, if your app holds a client already. Keep the interface
 * and keep `hashIntent`/`resumeDigest` as reads rather than computations.
 * **Assumes:** the module at `moduleAddress` is the one the account installed. `configOf` on an
 * account that never installed returns a zero `recoveryOwner` rather than reverting, so callers
 * check `isInitialized` instead of inferring from zeroes.
 */
import { getContract, type Address, type Hex, type PublicClient } from "viem";
import { recoveryModuleAbi, VetoStateOrdinal } from "@nihilium/recovery-onchain-evm";
import type { VetoState } from "@nihilium/recovery-core";
import { fromSolidityVetoConfig, type SolidityVetoConfig } from "./vetoConfig.js";
import type { VetoConfig } from "@nihilium/recovery-core";

export interface SolidityIntent {
    account: Address;
    epoch: bigint;
    nonce: bigint;
    newValidator: Address;
    newValidatorInitData: Hex;
    expiry: number;
}

export interface AccountConfig {
    recoveryOwner: Address;
    epoch: bigint;
    nonce: bigint;
    veto: VetoConfig;
}

export interface AttemptSnapshot {
    intentHash: Hex;
    state: VetoState | null;
    accruedSeconds: bigint;
    pausedSeconds: bigint;
    checkpointTime: bigint;
}

export interface ModuleReader {
    readonly moduleAddress: Address;
    isInitialized(account: Address): Promise<boolean>;
    configOf(account: Address): Promise<AccountConfig>;
    attemptOf(account: Address): Promise<AttemptSnapshot>;
    /** Read, never computed. See the header. */
    hashIntent(intent: SolidityIntent): Promise<Hex>;
    /** Read, never computed. See the header. */
    resumeDigest(account: Address, intentHash: Hex): Promise<Hex>;
    balanceOf(address: Address): Promise<bigint>;
}

/**
 * `NONE` has no counterpart in the SDK's `VetoState`: an attempt that does not exist is the absence
 * of a record there, not a state. Returning `null` keeps that distinction instead of inventing one.
 */
export function toVetoState(ordinal: number): VetoState | null {
    switch (ordinal) {
        case VetoStateOrdinal.NONE:
            return null;
        case VetoStateOrdinal.INITIATED:
            return "INITIATED";
        case VetoStateOrdinal.PAUSED:
            return "PAUSED";
        case VetoStateOrdinal.EXECUTABLE:
            return "EXECUTABLE";
        case VetoStateOrdinal.EXECUTED:
            return "EXECUTED";
        case VetoStateOrdinal.ABORTED:
            return "ABORTED";
        default:
            throw new Error(
                `The module reported veto state ordinal ${ordinal}, which this build does not know. ` +
                    "Treat an unknown state as unsafe rather than mapping it to the nearest known one.",
            );
    }
}

/** `EXECUTED` and `ABORTED` are terminal; anything else blocks a fresh `initiateRecovery`. */
export function isTerminal(state: VetoState | null): boolean {
    return state === "EXECUTED" || state === "ABORTED";
}

export function createModuleReader(
    client: PublicClient,
    moduleAddress: Address,
    namespace: string,
): ModuleReader {
    const module = getContract({ address: moduleAddress, abi: recoveryModuleAbi, client });

    return {
        moduleAddress,

        async isInitialized(account) {
            return module.read.isInitialized([account]) as Promise<boolean>;
        },

        async configOf(account) {
            const [recoveryOwner, epoch, nonce, veto] = (await module.read.configOf([account])) as [
                Address,
                bigint,
                bigint,
                SolidityVetoConfig,
            ];
            return { recoveryOwner, epoch, nonce, veto: fromSolidityVetoConfig(veto, namespace) };
        },

        async attemptOf(account) {
            const [intentHash, attempt] = (await module.read.attemptOf([account])) as [
                Hex,
                {
                    state: number;
                    accruedSeconds: bigint;
                    pausedSeconds: bigint;
                    checkpointTime: bigint;
                },
            ];
            return {
                intentHash,
                state: toVetoState(attempt.state),
                accruedSeconds: attempt.accruedSeconds,
                pausedSeconds: attempt.pausedSeconds,
                checkpointTime: attempt.checkpointTime,
            };
        },

        async hashIntent(intent) {
            return module.read.hashIntent([intent]) as Promise<Hex>;
        },

        async resumeDigest(account, intentHash) {
            return module.read.resumeDigest([account, intentHash]) as Promise<Hex>;
        },

        async balanceOf(address) {
            return client.getBalance({ address });
        },
    };
}
