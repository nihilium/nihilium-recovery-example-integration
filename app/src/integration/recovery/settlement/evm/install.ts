/**
 * Putting the recovery key on-chain — the half that makes a seal mean anything.
 *
 * Until this runs, the vault is finished and the account is exactly as recoverable as it was before:
 * the module has never heard of the recovery key, so nothing on Sepolia would honour it.
 *
 * **Only an account can install its own module.** ERC-7579 `installModule` is a call the account
 * makes on itself, so this is a UserOp signed by the wallet's own key and paid for by the account —
 * the relayer cannot do it, and a route offering to would be a route that cannot work. That is the
 * opposite of `initiateRecovery`, where the authority is the signature and anyone may send it.
 *
 * **Rotation is uninstall-then-install, in one UserOp.** The module has no setter: `onInstall`
 * reverts `AlreadyInstalled`, and `onUninstall` is what clears the recovery owner and the veto
 * config. Two separate transactions would leave a window in which the account has no recovery at
 * all, so both calls ride in one operation. The epoch deliberately survives an uninstall, being
 * replay-protection state, so intents signed for the old key stay dead afterwards.
 *
 * A rotation therefore begins with a **read**: Safe7579's uninstall needs the executor list's
 * predecessor pointer, and guessing it reverts the whole operation after paying for it. See
 * `executorPrev` in `erc7579.ts`.
 *
 * **To replace:** the account provider. Whether the smart account comes from permissionless,
 * Rhinestone or a factory of your own changes nothing below `encodeCalls`.
 * **Assumes:** a Safe carrying the Safe7579 adapter and the encodings in `erc7579.ts`; a funded
 * account (the UserOp is paid by it, and on first use also deploys it); and a bundler that accepts
 * it.
 */
import type { Address, Hex } from "viem";
import { createSafeClient } from "../../../chains/safeAccount.js";
import { executorPrev, installModuleCalldata, uninstallModuleCalldata } from "./erc7579.js";
import type { SolidityVetoConfig } from "./vetoConfig.js";

export interface InstallDeps {
    rpcUrl: string;
    bundlerUrl: string;
    /** The wallet's own key. Demo-only export; a real app holds a signer, not bytes. */
    ownerPrivateKeyHex: string;
    moduleAddress: Address;
    /** Must match what `deriveAccounts` used, or this addresses a different account entirely. */
    attester: Address;
}

export interface InstallParams {
    recoveryOwner: Address;
    veto: SolidityVetoConfig;
    /** The vault this replaces, if any. Present means uninstall-then-install in one operation. */
    replacing?: boolean;
    onProgress?: (message: string) => void;
}

export interface InstallResult {
    userOpHash: Hex;
    transactionHash: Hex;
    account: Address;
}

/**
 * Install the recovery module, or replace what is installed.
 *
 * One operation either way: a replacement sends `uninstallModule` and `installModule` together, so
 * there is no moment at which the account is unprotected and no half-applied rotation to strand it.
 */
export async function protectAccount(
    deps: InstallDeps,
    params: InstallParams,
): Promise<InstallResult> {
    const { client, account, publicClient } = await createSafeClient(deps);
    const target = account.address as Address;

    const install = {
        to: target,
        value: 0n,
        data: installModuleCalldata(deps.moduleAddress, params.recoveryOwner, params.veto),
    };

    let calls = [install];
    if (params.replacing === true) {
        // Read before encoding, and let it throw: a wrong `prev` is a revert inside the account,
        // which costs the gas and rotates nothing.
        const prev = await executorPrev(publicClient, target, deps.moduleAddress);
        calls = [
            {
                to: target,
                value: 0n,
                data: uninstallModuleCalldata(deps.moduleAddress, prev),
            },
            install,
        ];
    }

    params.onProgress?.(
        params.replacing === true
            ? `rotate     uninstall + install in one userOp on ${target}`
            : `protect    installModule on ${target}`,
    );

    const userOpHash = await client.sendUserOperation({ calls });
    params.onProgress?.(`userOp     ${userOpHash} — waiting for the bundler`);

    const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
    // A UserOp can be mined and still have reverted inside the account; the bundler is paid either
    // way. Reading `success` is the difference between "it landed" and "it worked".
    if (!receipt.success) {
        throw new Error(
            `The install operation was mined in ${receipt.receipt.transactionHash} but reverted ` +
                "inside the account. The module is not installed, and the gas is spent.",
        );
    }

    params.onProgress?.(`protect    tx=${receipt.receipt.transactionHash}`);
    return {
        userOpHash,
        transactionHash: receipt.receipt.transactionHash,
        account: target,
    };
}
