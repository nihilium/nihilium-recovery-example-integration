/**
 * One Kernel smart-account client, built the same way for everything that sends a UserOp.
 *
 * Two callers need it and they must agree: installing the recovery module, and sending value. If
 * they built the account differently — a different Kernel version, a different entry point — they
 * would be addressing two different accounts while appearing to address one, and the second would
 * quietly be a counterfactual address with no funds and no module.
 *
 * **The fee callback is not optional.** A bundler rejects a UserOp with no `maxFeePerGas` /
 * `maxPriorityFeePerGas`, viem does not fill them in, and the rejection arrives disguised as
 * `eth_estimateUserOperationGas does not exist / is not available` with the real validation error
 * buried underneath — so it reads as an unsupported bundler rather than an incomplete operation.
 *
 * **To replace:** the whole file, with whatever provisions your smart accounts. Nothing above the
 * `client` it returns cares whether that is permissionless, ZeroDev or a factory of your own.
 * **Assumes:** the demo's private-key export. A real app holds a signer and never sees bytes.
 */
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { toKernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";

/**
 * Pinned, and pinned in one place.
 *
 * The account's address is derived from this: changing it moves the account, stranding whatever the
 * old one held and whatever module it had installed.
 */
export const KERNEL_VERSION = "0.3.3" as const;

export interface KernelClientOptions {
    rpcUrl: string;
    bundlerUrl: string;
    /** Demo-only. See the header. */
    ownerPrivateKeyHex: string;
}

export async function createKernelClient(options: KernelClientOptions) {
    const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(options.rpcUrl),
    }) as PublicClient;

    const owner = privateKeyToAccount(
        (options.ownerPrivateKeyHex.startsWith("0x")
            ? options.ownerPrivateKeyHex
            : `0x${options.ownerPrivateKeyHex}`) as Hex,
    );

    const account = await toKernelSmartAccount({
        client: publicClient,
        owners: [owner],
        entryPoint: { address: entryPoint07Address, version: "0.7" },
        version: KERNEL_VERSION,
    });

    // Ask the bundler for its own prices — it is the party deciding what it will accept.
    // `pimlico_getUserOperationGasPrice` is not standard, so a bundler without it falls through to
    // the chain's estimate rather than failing.
    const pimlico = createPimlicoClient({ transport: http(options.bundlerUrl) });

    const client = createSmartAccountClient({
        account,
        chain: sepolia,
        bundlerTransport: http(options.bundlerUrl),
        userOperation: {
            estimateFeesPerGas: async () => {
                try {
                    return (await pimlico.getUserOperationGasPrice()).fast;
                } catch {
                    const fees = await publicClient.estimateFeesPerGas();
                    return {
                        maxFeePerGas: fees.maxFeePerGas,
                        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                    };
                }
            },
        },
    });

    return { publicClient, account, client };
}
