/**
 * Everything this app reads from an EOA delegated to `Eip7702RecoveryAccount`, behind one interface.
 *
 * The twin of `../evm/reads.ts`, with one structural difference: there is no module address and no
 * `account` argument. After delegation the EOA *is* the contract, so every read is made **at the
 * EOA's address** and acts on that EOA's own storage. Reading at the implementation's address
 * instead returns the implementation's (empty) state and, worse, digests under the wrong EIP-712
 * domain: `verifyingContract` is `address(this)`, which is the EOA.
 *
 * **The same rule as the module: never compute a digest locally.** `hashIntent`, `hashRegister` and
 * `hashExecute` are reads. The domain includes `version()`, which moved from 1.0.0 to 1.1.0 when
 * `receive()` was added, and a hand-built digest would have gone on signing for the old one.
 *
 * **Superseded versions are still ours.** An account delegated to an older implementation keeps
 * working, and its views are the same, so every read here works against it. `delegation()` says
 * which version it is, so a caller can offer the upgrade.
 *
 * **To replace:** the viem implementation, if your app holds a client already. **Assumes:** callers
 * check `delegation()` before anything else. On an undelegated EOA every other read returns empty
 * bytes and fails to decode, which is not the same as "not registered".
 */
import {
    BaseError,
    getAddress,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import {
    eip7702RecoveryAccountAbi,
    legacyEip7702AccountAddresses,
} from "@nihilium/recovery-onchain-evm";
import type { VetoConfig, VetoState } from "@nihilium/recovery-core";
import { toVetoState, type AttemptClockRead, type AttemptSnapshot } from "../evm/reads.js";
import { fromSolidityVetoConfig, type SolidityVetoConfig } from "../evm/vetoConfig.js";

/** The contract's `Intent`. Shorter than the module's: no account, no validator, just an owner. */
export interface Eip7702Intent {
    epoch: bigint;
    nonce: bigint;
    newOwner: Address;
    expiry: number;
}

/** The contract's `RegisterMessage`. `nonce` is `configNonce`, never the recovery nonce. */
export interface RegisterMessage {
    recoveryOwner: Address;
    veto: SolidityVetoConfig;
    nonce: bigint;
}

/** One call the owner authorises through `execute`. */
export interface Eip7702Call {
    target: Address;
    value: bigint;
    data: Hex;
}

export interface Eip7702Config {
    /** The EOA itself until a recovery executes; the recovered owner after. */
    currentOwner: Address;
    recoveryOwner: Address;
    epoch: bigint;
    nonce: bigint;
    /** What a `register` must name. Bumped by every registration, including the first. */
    configNonce: bigint;
    /** What an `execute` signature binds. Read by the contract, not passed in. */
    execNonce: bigint;
    veto: VetoConfig;
}

/**
 * What the EOA's code says it is.
 *
 * - `ours`: the implementation the SDK currently names.
 * - `legacy`: a superseded version of it, from `legacyEip7702AccountAddresses`. Still a working
 *   recovery account, and re-delegating to the current one is an upgrade: every version keeps its
 *   state in the same ERC-7201 slot with the same field order, so the registration carries over.
 * - `other`: somebody else's wallet code, which a delegation here would silently replace.
 */
export type Delegation =
    | { kind: "none" }
    | { kind: "ours" }
    | { kind: "legacy"; version: string; target: Address }
    | { kind: "other"; target: Address | null };

/** EIP-7702's delegation designator: `0xef0100` followed by the 20-byte target. */
const DESIGNATOR_PREFIX = "0xef0100";

/** Every superseded implementation, by address. Addresses are per deployment, so chains cannot collide. */
const LEGACY: ReadonlyMap<string, string> = new Map(
    Object.entries(legacyEip7702AccountAddresses).flatMap(([version, byChain]) =>
        Object.values(byChain).map((address) => [getAddress(address), version] as const),
    ),
);

export function parseDelegation(
    code: Hex | undefined,
    implementation: Address,
    legacy: ReadonlyMap<string, string> = LEGACY,
): Delegation {
    if (code === undefined || code === "0x") return { kind: "none" };
    const lower = code.toLowerCase();
    if (!lower.startsWith(DESIGNATOR_PREFIX) || lower.length !== DESIGNATOR_PREFIX.length + 40) {
        // Real contract code at this address, not a delegation. Not an EOA this chain can protect.
        return { kind: "other", target: null };
    }
    const target = getAddress(`0x${lower.slice(DESIGNATOR_PREFIX.length)}`);
    if (target === getAddress(implementation)) return { kind: "ours" };
    const version = legacy.get(target);
    return version !== undefined ? { kind: "legacy", version, target } : { kind: "other", target };
}

/** Delegated to any version of the recovery account, current or superseded: its state is readable. */
export function isRecoveryAccount(delegation: Delegation): boolean {
    return delegation.kind === "ours" || delegation.kind === "legacy";
}

export interface Eip7702Reader {
    readonly account: Address;
    readonly implementation: Address;
    delegation(): Promise<Delegation>;
    /**
     * Whether the implementation accepts a plain ETH transfer.
     *
     * Asked of the implementation rather than of this account, so it can be answered before the
     * account delegates. That is the only moment the answer is useful: an EOA delegated to code
     * without `receive()` cannot be paid again, and a lost key cannot undo the delegation.
     */
    implementationAcceptsValue(): Promise<boolean>;
    isRegistered(): Promise<boolean>;
    configOf(): Promise<Eip7702Config>;
    attemptOf(): Promise<AttemptSnapshot & { attemptSeq: bigint }>;
    /** Projected forward, like the module's. See `../evm/reads.ts`. */
    stateOf(): Promise<VetoState | null>;
    hashIntent(intent: Eip7702Intent): Promise<Hex>;
    hashRegister(reg: RegisterMessage): Promise<Hex>;
    hashExecute(calls: readonly Eip7702Call[], expiry: number): Promise<Hex>;
    balance(): Promise<bigint>;
}

/** A funded sender that exists only inside the probe's `eth_call`. */
const PROBE_SENDER: Address = "0x000000000000000000000000000000000000bEEF";

export function createEip7702Reader(
    client: PublicClient,
    account: Address,
    implementation: Address,
    namespace: string,
): Eip7702Reader {
    const at = { address: account, abi: eip7702RecoveryAccountAbi } as const;

    return {
        account,
        implementation,

        async delegation() {
            return parseDelegation(await client.getCode({ address: account }), implementation);
        },

        async implementationAcceptsValue() {
            try {
                await client.call({
                    account: PROBE_SENDER,
                    to: implementation,
                    value: 1n,
                    stateOverride: [{ address: PROBE_SENDER, balance: 10n ** 18n }],
                });
                return true;
            } catch (error) {
                // A revert is the answer. Anything else is a check that did not run, and must not
                // read as either answer.
                const reverted =
                    error instanceof BaseError &&
                    error.walk((e) => (e as { name?: string }).name === "ExecutionRevertedError") !==
                        null;
                if (reverted) return false;
                throw error;
            }
        },

        async isRegistered() {
            return client.readContract({ ...at, functionName: "isRegistered" });
        },

        async configOf() {
            const [currentOwner, recoveryOwner, epoch, nonce, configNonce, execNonce, veto] =
                await client.readContract({ ...at, functionName: "configOf" });
            return {
                currentOwner,
                recoveryOwner,
                epoch,
                nonce,
                configNonce,
                execNonce,
                veto: fromSolidityVetoConfig(veto as SolidityVetoConfig, namespace),
            };
        },

        async attemptOf() {
            const [intentHash, attemptSeq, veto] = await client.readContract({
                ...at,
                functionName: "attemptOf",
            });
            return {
                intentHash,
                attemptSeq,
                state: toVetoState(Number(veto.state)),
                accruedSeconds: BigInt(veto.accruedSeconds),
                pausedSeconds: BigInt(veto.pausedSeconds),
                checkpointTime: BigInt(veto.checkpointTime),
            };
        },

        async stateOf() {
            return toVetoState(Number(await client.readContract({ ...at, functionName: "stateOf" })));
        },

        async hashIntent(intent) {
            return client.readContract({ ...at, functionName: "hashIntent", args: [intent] });
        },

        async hashRegister(reg) {
            return client.readContract({ ...at, functionName: "hashRegister", args: [reg] });
        },

        async hashExecute(calls, expiry) {
            return client.readContract({
                ...at,
                functionName: "hashExecute",
                args: [calls, expiry],
            });
        },

        async balance() {
            return client.getBalance({ address: account });
        },
    };
}

/** The clock, read as one snapshot. The same pairing rule as `../evm/reads.ts#readAttemptClock`. */
export async function readAttemptClock(reader: Eip7702Reader): Promise<AttemptClockRead> {
    const [config, attempt, projected] = await Promise.all([
        reader.configOf(),
        reader.attemptOf(),
        reader.stateOf(),
    ]);
    return {
        projected,
        clock: {
            state: attempt.state,
            accruedSeconds: Number(attempt.accruedSeconds),
            pausedSeconds: Number(attempt.pausedSeconds),
            checkpointSeconds: Number(attempt.checkpointTime),
            timelockSeconds: config.veto.timelockSeconds,
            pauseCeilingSeconds: config.veto.pauseCeilingSeconds,
        },
    };
}
