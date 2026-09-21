/**
 * Everything that can be known before a recovery starts, checked before it starts.
 *
 * A recovery is minutes of real people answering real email, and it is paid. Every refusal below is
 * one this app could otherwise discover *after* all of that — at `initiateRecovery`, as a revert
 * whose reason points nowhere near the cause. Finding out now costs a few `eth_call`s.
 *
 * The one that matters most is the epoch. `ChainContext.epoch` is an HKDF input that the envelope
 * does not carry, so recovering at the wrong one yields a different, perfectly valid key for an
 * account that has never heard of it — no error at any layer. Here that becomes a mismatch between
 * the `recoveryOwner` the chain holds and the key the vault recorded, which is the same fact caught
 * one step earlier and for free.
 *
 * **To replace:** `MIN_EXPIRY_MARGIN_SECONDS` and `MIN_RELAYER_BALANCE_WEI`, which are this demo's
 * judgement. Keep the checks and keep them before the ceremony, not between it and the chain.
 * **Assumes:** the caller passes the vault's own recorded `recoveryPubKeyHex`, not one re-derived
 * from a seed — re-deriving here would make the check compare a value against itself.
 */
import { getAddress, type Address } from "viem";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { isTerminal, type ModuleReader } from "./reads.js";

/** An intent must outlast the timelock it authorises, with room for a slow bundler and a human. */
export const MIN_EXPIRY_MARGIN_SECONDS = 300;

/** ~0.002 ETH. Enough for an initiate and an execute on Sepolia at ordinary gas. */
export const MIN_RELAYER_BALANCE_WEI = 2_000_000_000_000_000n;

export type PreflightCode =
    | "not-installed"
    | "owner-mismatch"
    | "attempt-in-flight"
    | "expiry-too-short"
    | "relayer-unfunded";

export interface PreflightProblem {
    code: PreflightCode;
    /** Written for the person about to spend money, not for a log. */
    message: string;
    /** True when continuing is impossible rather than merely unwise. */
    blocking: boolean;
}

export interface PreflightParams {
    account: Address;
    /** `recoveryPubKeyHex` from the vault's chain record — what `addChain()` returned. */
    expectedRecoveryPubKeyHex: string;
    relayer?: Address;
    intentTtlSeconds: number;
}

/**
 * Every problem, not the first.
 *
 * A screen that reports one refusal, gets fixed, and then reports the next is a screen that spends
 * three round trips saying what it knew at the start.
 */
export async function preflightRecovery(
    reader: ModuleReader,
    params: PreflightParams,
): Promise<PreflightProblem[]> {
    const problems: PreflightProblem[] = [];

    if (!(await reader.isInitialized(params.account))) {
        // Nothing else is worth reading: `configOf` on an uninstalled account returns zeroes, and
        // every check below would then fail for the wrong reason.
        return [
            {
                code: "not-installed",
                blocking: true,
                message:
                    "This account has no recovery module installed, so there is nothing on-chain " +
                    "that would honour a recovery key. Protect the account first — sealing is only " +
                    "the off-chain half.",
            },
        ];
    }

    const [config, attempt] = await Promise.all([
        reader.configOf(params.account),
        reader.attemptOf(params.account),
    ]);

    const expected = recoveryOwnerAddress(params.expectedRecoveryPubKeyHex);
    if (getAddress(config.recoveryOwner) !== expected) {
        problems.push({
            code: "owner-mismatch",
            blocking: true,
            message:
                `The chain expects recovery owner ${config.recoveryOwner}, and this vault's key is ` +
                `${expected}. The account is protected by a different vault — usually because the ` +
                "guardians were replaced and the rotation never landed on-chain. Finish the " +
                "rotation before recovering, or this ceremony opens a vault the account ignores.",
        });
    }

    if (attempt.state !== null && !isTerminal(attempt.state)) {
        problems.push({
            code: "attempt-in-flight",
            blocking: true,
            message:
                `A recovery is already ${attempt.state} on this account. The module allows one ` +
                "attempt at a time; this one must reach executed or aborted first.",
        });
    }

    if (params.intentTtlSeconds <= config.veto.timelockSeconds + MIN_EXPIRY_MARGIN_SECONDS) {
        problems.push({
            code: "expiry-too-short",
            blocking: true,
            message:
                `The intent would expire after ${params.intentTtlSeconds}s, and the timelock alone ` +
                `is ${config.veto.timelockSeconds}s. The signature would lapse before the recovery ` +
                "it authorises could mature, so the ceremony could only ever have ended here.",
        });
    }

    if (params.relayer !== undefined) {
        const balance = await reader.balanceOf(params.relayer);
        if (balance < MIN_RELAYER_BALANCE_WEI) {
            problems.push({
                // Not blocking: the relayer can be funded while the ceremony runs, and refusing to
                // start over a balance that a single transfer fixes would be the wrong trade.
                code: "relayer-unfunded",
                blocking: false,
                message:
                    `The relayer holds ${balance} wei, below the ${MIN_RELAYER_BALANCE_WEI} needed ` +
                    "for an initiate and an execute. Fund it before the timelock matures.",
            });
        }
    }

    return problems;
}

/** The same owner check, for the `stale` badge — a comparison, not a refusal. */
export async function isProtectedByVault(
    reader: ModuleReader,
    account: Address,
    expectedRecoveryPubKeyHex: string,
): Promise<boolean> {
    if (!(await reader.isInitialized(account))) return false;
    const config = await reader.configOf(account);
    return getAddress(config.recoveryOwner) === recoveryOwnerAddress(expectedRecoveryPubKeyHex);
}

/**
 * The module's `recoveryOwner` is the EVM address of the vault's recovery public key.
 *
 * `toEvmAddress` comes from the SDK rather than being re-implemented here, and deliberately: it is
 * the same function `deriveAccounts` uses for the wallet's own EOA, so a checksum or keccak
 * difference between the two could not survive.
 */
function recoveryOwnerAddress(recoveryPubKeyHex: string): Address {
    return getAddress(
        toEvmAddress({ algorithm: "secp256k1", bytes: hexToBytes(recoveryPubKeyHex) }),
    );
}

function hexToBytes(hex: string): Uint8Array {
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}
