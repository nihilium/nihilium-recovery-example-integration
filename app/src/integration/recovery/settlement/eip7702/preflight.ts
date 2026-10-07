/**
 * What can be known before touching a 7702-protected EOA, checked before touching it.
 *
 * Two moments, two lists:
 *
 * - **Before protecting.** A delegation is not undoable by the person this exists for. The
 *   authorization must be signed by the EOA's own key, so an owner who has lost it can never
 *   re-point the code. So the two ways a delegation goes wrong are refused here, before it is
 *   signed: code that cannot receive ETH, which would make the account spend-only for good, and an
 *   EOA already delegated to somebody else's wallet code, which this would silently replace. An
 *   EOA on a *superseded version of ours* is not refused: re-delegating it is the upgrade.
 * - **Before a recovery.** The same shape as `../evm/preflight.ts`: not protected, protected by a
 *   different vault, an attempt already running, or an intent that would expire before its timelock.
 *   Each is otherwise discovered after the ceremony, as a revert.
 *
 * **To replace:** nothing but the wording. **Assumes:** the caller passes the vault's recorded
 * `recoveryPubKeyHex`, not one re-derived from a seed, or the owner check compares a value with
 * itself.
 */
import { getAddress, type Address } from "viem";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { isTerminal } from "../evm/reads.js";
import { MIN_EXPIRY_MARGIN_SECONDS, type PreflightProblem } from "../evm/preflight.js";
import { isRecoveryAccount, type Eip7702Reader } from "./reads.js";

export type Eip7702PreflightCode =
    | "implementation-cannot-receive"
    | "delegated-elsewhere"
    | "not-delegated"
    | "not-registered"
    | "owner-mismatch"
    | "attempt-in-flight"
    | "expiry-too-short";

export type Eip7702Problem = Omit<PreflightProblem, "code"> & { code: Eip7702PreflightCode };

/** Every reason delegating this EOA would be wrong. Empty means go ahead. */
export async function preflightProtect(reader: Eip7702Reader): Promise<Eip7702Problem[]> {
    const problems: Eip7702Problem[] = [];
    const [accepts, delegation] = await Promise.all([
        reader.implementationAcceptsValue(),
        reader.delegation(),
    ]);
    if (!accepts) {
        problems.push({
            code: "implementation-cannot-receive",
            blocking: true,
            message:
                `The recovery contract at ${reader.implementation} cannot receive ETH. ` +
                "Delegating to it would stop this account from ever being paid again.",
        });
    }
    if (delegation.kind === "other") {
        problems.push({
            code: "delegated-elsewhere",
            blocking: true,
            message:
                delegation.target === null
                    ? `${reader.account} holds contract code, not a delegation. It is not an account this chain can protect.`
                    : `${reader.account} already runs code from ${delegation.target}. Protecting it would replace that.`,
        });
    }
    return problems;
}

export interface RecoveryPreflightParams {
    /** `recoveryPubKeyHex` from the vault's chain record. */
    expectedRecoveryPubKeyHex: string;
    intentTtlSeconds: number;
}

/** Every reason `initiateRecovery` would be refused. Empty means a ceremony is worth running. */
export async function preflightRecovery(
    reader: Eip7702Reader,
    params: RecoveryPreflightParams,
): Promise<Eip7702Problem[]> {
    const delegation = await reader.delegation();
    // A superseded version still honours its registration, so it can still be recovered.
    if (!isRecoveryAccount(delegation)) {
        // Nothing else can be read: an undelegated EOA has no code to answer.
        return [
            {
                code: "not-delegated",
                blocking: true,
                message:
                    delegation.kind === "none"
                        ? "This account was never protected, so nothing on-chain would honour a recovery key."
                        : "This account runs other code now, so nothing on-chain would honour a recovery key.",
            },
        ];
    }
    if (!(await reader.isRegistered())) {
        return [
            {
                code: "not-registered",
                blocking: true,
                message:
                    "This account is delegated but no recovery key is registered on it. Protect it first.",
            },
        ];
    }

    const problems: Eip7702Problem[] = [];
    const [config, attempt] = await Promise.all([reader.configOf(), reader.attemptOf()]);

    const expected = recoveryOwnerAddress(params.expectedRecoveryPubKeyHex);
    if (getAddress(config.recoveryOwner) !== expected) {
        problems.push({
            code: "owner-mismatch",
            blocking: true,
            message:
                `The chain expects recovery owner ${config.recoveryOwner}, and this vault's key is ` +
                `${expected}. The account is protected by a different vault.`,
        });
    }
    if (attempt.state !== null && !isTerminal(attempt.state)) {
        problems.push({
            code: "attempt-in-flight",
            blocking: true,
            message: `A recovery is already ${attempt.state} on this account.`,
        });
    }
    if (params.intentTtlSeconds <= config.veto.timelockSeconds + MIN_EXPIRY_MARGIN_SECONDS) {
        problems.push({
            code: "expiry-too-short",
            blocking: true,
            message:
                `The intent would expire after ${params.intentTtlSeconds}s, and the timelock alone ` +
                `is ${config.veto.timelockSeconds}s.`,
        });
    }
    return problems;
}

/** Whether the chain holds this vault's key. A comparison for the badge, not a refusal. */
export async function isProtectedByVault(
    reader: Eip7702Reader,
    expectedRecoveryPubKeyHex: string,
): Promise<boolean> {
    if (!isRecoveryAccount(await reader.delegation())) return false;
    if (!(await reader.isRegistered())) return false;
    const config = await reader.configOf();
    return getAddress(config.recoveryOwner) === recoveryOwnerAddress(expectedRecoveryPubKeyHex);
}

/** The SDK's own `toEvmAddress`, the one `addChain()` used: a second implementation would drift. */
export function recoveryOwnerAddress(recoveryPubKeyHex: string): Address {
    const body = recoveryPubKeyHex.startsWith("0x") ? recoveryPubKeyHex.slice(2) : recoveryPubKeyHex;
    const bytes = new Uint8Array(body.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    }
    return getAddress(toEvmAddress({ algorithm: "secp256k1", bytes }));
}
