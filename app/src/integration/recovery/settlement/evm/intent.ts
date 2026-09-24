/**
 * The message a recovered key signs, and the one thing it is allowed to authorise.
 *
 * An intent says: *for this account, at this epoch and nonce, install this validator with this
 * configuration, before this time*. It does not move funds and cannot be made to — the module's
 * `executeRecovery` installs a validator and bumps the epoch, and that is the entire blast radius of
 * a recovery signature.
 *
 * Three fields are replay protection and each closes a different door. `epoch` is bumped by every
 * completed recovery, so a signature from before one is dead afterwards — and it survives a module
 * uninstall deliberately, so rotating the guardian set does not resurrect old intents. `nonce`
 * separates attempts within an epoch. `expiry` bounds how long a signature sits usable; it must
 * outlast the timelock or the recovery it authorises can never mature, which `preflight.ts` checks.
 *
 * **The digest is read from the chain, never computed here.** See `reads.ts` for why — the deployed
 * module and the Solidity in the sibling checkout report different `version()` strings, and that
 * string is inside the EIP-712 domain separator.
 *
 * **To replace:** `DEFAULT_INTENT_TTL_SECONDS`, which is a product decision. Keep `buildIntent` as
 * the only constructor, the way `chainContextOf` is for `ChainContext`.
 * **Assumes:** `newValidator` is a validator the account does not already run. Installing one it has
 * makes `onInstall` revert `AlreadyInitialized` at execution time, after the whole timelock.
 */
import type { RecoveryIntent } from "@nihilium/recovery-core";
import type { Address, Hex } from "viem";
import { OWNABLE_VALIDATOR_ADDRESS, recoveryValidatorInitData } from "./erc7579.js";
import type { ModuleReader, SolidityIntent } from "./reads.js";

/**
 * An hour. Long enough that a demo timelock plus a human reading the screen fits inside it, short
 * enough that a signature left lying around stops being useful quickly.
 */
export const DEFAULT_INTENT_TTL_SECONDS = 3600;

/** `uint48` on-chain — roughly the year 8.9 million, but the cast has to be checked, not assumed. */
const MAX_UINT48 = 2 ** 48 - 1;

export interface BuildIntentParams {
    account: Address;
    /** The recovered key's address: who ends up controlling the account. */
    newOwner: Address;
    /** From `configOf()`, read now. Never carried over from an earlier read. */
    epoch: bigint;
    nonce: bigint;
    moduleAddress: Address;
    ttlSeconds?: number;
    /** Injected so a test can pin the expiry. */
    now?: () => number;
}

/**
 * The only place an intent is constructed.
 *
 * Returns both shapes on purpose: the SDK's `RecoveryIntent` is what `SettlementAdapter` speaks, and
 * the Solidity tuple is what the contract takes. Deriving one from the other at three call sites is
 * how the two drift.
 */
export function buildIntent(params: BuildIntentParams): {
    intent: RecoveryIntent;
    solidity: SolidityIntent;
} {
    const nowSeconds = Math.floor((params.now?.() ?? Date.now()) / 1000);
    const expiry = nowSeconds + (params.ttlSeconds ?? DEFAULT_INTENT_TTL_SECONDS);
    if (!Number.isInteger(expiry) || expiry <= nowSeconds || expiry > MAX_UINT48) {
        // A silently truncated expiry produces a signature the module treats as long expired.
        throw new Error(
            `Intent expiry ${expiry} does not fit uint48 or is not in the future.`,
        );
    }

    const newValidatorInitData = recoveryValidatorInitData(params.newOwner);

    const solidity: SolidityIntent = {
        account: params.account,
        epoch: params.epoch,
        nonce: params.nonce,
        newValidator: OWNABLE_VALIDATOR_ADDRESS,
        newValidatorInitData,
        expiry,
    };

    const intent: RecoveryIntent = {
        accountId: params.account,
        module: params.moduleAddress,
        epoch: Number(params.epoch),
        nonce: params.nonce,
        newOwnerConfig: hexToBytes(newValidatorInitData),
        expiry,
    };

    return { intent, solidity };
}

/** The digest to sign. A read, always — see the header. */
export async function intentDigest(reader: ModuleReader, solidity: SolidityIntent): Promise<Hex> {
    return reader.hashIntent(solidity);
}

function hexToBytes(hex: Hex): Uint8Array {
    const body = hex.slice(2);
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}
