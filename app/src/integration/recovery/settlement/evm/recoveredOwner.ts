/**
 * Driving the account with the key a recovery produced — the step that makes the recovery true.
 *
 * `executeRecovery` installs `OwnableValidator` with the intent's `newOwner` as sole owner and
 * bumps the epoch. That is where this repo used to stop, which left the whole point unproven: the
 * claim is that the owner has their account back, and the demonstration of that is value leaving
 * the account under the new key.
 *
 * **The signer here is the recovery's target, not the key the vault gave up.** Those are different
 * on purpose — see `buildIntent` and `WalletSnapshot.recoveryTarget`. The recovered key's only job
 * was to authorise the intent; it came out of a vault the recovery spent, so handing the account to
 * it would hand the account to something already exposed. What ends up controlling the account is
 * the key the owner still holds, and that is what signs below.
 *
 * **On a Safe, the validator is chosen by the UserOp's nonce key, not by its signature.** Safe7579
 * reads `validator := shr(96, nonce)`, so the account picks a path before it ever looks at the
 * bytes. Two consequences, and both are silent:
 *
 * - `nonce` bits `[255:64]` are the key, so the validator sits in the key's **top 160 bits**: the key
 *   is the address shifted left by 32. Get that wrong and `validator` is an address nothing has
 *   installed, at which point Safe7579 falls back to `checkSignatures` against the **Safe's owners**
 *   — the lost key. The operation is then rejected for a bad signature, which reads as a signing
 *   bug rather than a routing one.
 * - The Safe's owners still work. Recovery **added** a path; it did not remove one. The old EOA can
 *   still act through `execTransaction`, entirely outside ERC-7579, and this demo says so on screen
 *   rather than implying a revocation that did not happen.
 *
 * **OwnableValidator wants an EIP-191 signature, not a raw ECDSA over the digest.** It hashes the
 * message before recovering, so signing the `userOpHash` directly returns `false` from a validator
 * that is installed and configured correctly. Verified against the deployed contract; the
 * `signMessage({ raw })` below is that, and is not interchangeable with `sign({ hash })`.
 *
 * **To replace:** nothing, for any ERC-7579 account that routes by nonce key. For an account that
 * routes by a signature prefix, move the validator address there instead.
 * **Assumes:** the account is already deployed — a recovery cannot have executed on one that is not
 * — and that the recovery installed exactly the validator and configuration `intent.ts` built, with
 * this key as its sole owner.
 */
import {
    concatHex,
    createPublicClient,
    encodeAbiParameters,
    encodeFunctionData,
    encodePacked,
    http,
    pad,
    toHex,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import {
    entryPoint07Abi,
    entryPoint07Address,
    getUserOperationHash,
    toSmartAccount,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { bundlerFeeEstimator } from "../../../chains/safeAccount.js";
import { OWNABLE_VALIDATOR_ADDRESS } from "./erc7579.js";

/**
 * The nonce key that routes a UserOp to a validator.
 *
 * `nonce = key << 64 | sequence`, and Safe7579 takes `nonce >> 96`, so the 20-byte address has to
 * land in the top 160 bits of the 192-bit key — a right-pad to 24 bytes. Exported so a test can pin
 * it, because the failure mode is a valid-looking rejection rather than an error.
 */
export function validatorNonceKey(validator: Address): bigint {
    return BigInt(pad(validator, { dir: "right", size: 24 }));
}

/** ERC-7579 `execute(bytes32 mode, bytes executionCalldata)` — the account's own surface. */
const erc7579ExecuteAbi = [
    {
        type: "function",
        name: "execute",
        inputs: [
            { name: "mode", type: "bytes32" },
            { name: "executionCalldata", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "payable",
    },
] as const;

/**
 * `ModeCode` is a packed bytes32: callType, execType, 4 reserved bytes, a 4-byte mode selector and
 * a 22-byte payload. Everything but the call type is zero here — default exec, no mode, no payload.
 */
const MODE_SINGLE: Hex = pad("0x00", { dir: "right", size: 32 });
const MODE_BATCH: Hex = pad("0x01", { dir: "right", size: 32 });

interface Call {
    to: Address;
    value?: bigint | undefined;
    data?: Hex | undefined;
}

/** Single is packed; batch is an ABI-encoded `Execution[]`. The standard asks for both. */
function encodeExecution(calls: readonly Call[]): Hex {
    if (calls.length === 1) {
        const call = calls[0]!;
        return encodeFunctionData({
            abi: erc7579ExecuteAbi,
            functionName: "execute",
            args: [
                MODE_SINGLE,
                encodePacked(
                    ["address", "uint256", "bytes"],
                    [call.to, call.value ?? 0n, call.data ?? "0x"],
                ),
            ],
        });
    }

    return encodeFunctionData({
        abi: erc7579ExecuteAbi,
        functionName: "execute",
        args: [
            MODE_BATCH,
            encodeAbiParameters(
                [
                    {
                        type: "tuple[]",
                        components: [
                            { name: "target", type: "address" },
                            { name: "value", type: "uint256" },
                            { name: "callData", type: "bytes" },
                        ],
                    },
                ],
                [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? "0x" }))],
            ),
        ],
    });
}

export interface RecoveredOwnerDeps {
    rpcUrl: string;
    bundlerUrl: string;
    /** The account the recovery ran against — `ChainContext.accountId`, already deployed. */
    account: Address;
    /**
     * The key the recovery handed control to: the intent's `newOwner`, and the sole owner of the
     * validator that `executeRecovery` installed.
     *
     * Demo-only as bytes. A real app holds a signer for this — it is the key that survived the
     * loss, so it is the one thing in the flow that should never be exported.
     */
    newOwnerPrivateKeyHex: string;
}

/**
 * A client that sends UserOps from `account`, authorised through the installed validator.
 *
 * The account object is built here rather than through `permissionless`'s Safe account, because
 * that one signs as a Safe *owner* — which after a recovery is still the key that was lost.
 */
/**
 * The account's nonce, **always** on the validator's key — whatever key the caller asks for.
 *
 * Safe7579 decides which validator checks a UserOp from the nonce key, so the key is the routing,
 * not a counter. viem's `toSmartAccount` wraps this function and always supplies a key of its own —
 * `parameters?.key ?? Date.now()` — before calling it, so an implementation that honoured the
 * incoming key (as this one did) never saw `undefined` and never fell back to the validator's. The
 * sweep then went out on a timestamp key, Safe7579 validated it against the Safe's *original* owner
 * — the lost key — and the bundler answered `AA24 signature error` for a signature that was correct.
 *
 * Exported so the test can drive it through viem's real wrapper, which is where the key goes wrong.
 */
export function routedNonce(
    publicClient: PublicClient,
    account: Address,
    nonceKey: bigint,
): () => Promise<bigint> {
    return () =>
        publicClient.readContract({
            address: entryPoint07Address,
            abi: entryPoint07Abi,
            functionName: "getNonce",
            args: [account, nonceKey],
        });
}

export async function createRecoveredOwnerClient(deps: RecoveredOwnerDeps) {
    const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(deps.rpcUrl),
    }) as PublicClient;

    const signer = privateKeyToAccount(
        (deps.newOwnerPrivateKeyHex.startsWith("0x")
            ? deps.newOwnerPrivateKeyHex
            : `0x${deps.newOwnerPrivateKeyHex}`) as Hex,
    );
    const nonceKey = validatorNonceKey(OWNABLE_VALIDATOR_ADDRESS);

    const account = await toSmartAccount({
        client: publicClient,
        entryPoint: {
            abi: entryPoint07Abi,
            address: entryPoint07Address,
            version: "0.7",
        },

        async getAddress() {
            return deps.account;
        },

        // Deployed already, necessarily: a recovery executed against it. Returning factory args
        // would make the bundler try to deploy an account that exists.
        async getFactoryArgs() {
            return {};
        },

        async encodeCalls(calls) {
            return encodeExecution(calls as readonly Call[]);
        },

        getNonce: routedNonce(publicClient, deps.account, nonceKey),

        // 65 bytes of plausible ECDSA, so gas estimation charges for a real signature check.
        async getStubSignature() {
            return concatHex([
                `0x${"ff".repeat(32)}`,
                `0x${"ff".repeat(32)}`,
                "0x1c",
            ]);
        },

        async signMessage({ message }) {
            return signer.signMessage({ message });
        },

        async signTypedData(typedData) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's generic
            return signer.signTypedData(typedData as any);
        },

        async signUserOperation(userOperation) {
            const { chainId = sepolia.id, ...operation } = userOperation;
            const hash = getUserOperationHash({
                chainId,
                entryPointAddress: entryPoint07Address,
                entryPointVersion: "0.7",
                userOperation: { ...operation, sender: deps.account } as never,
            });
            // EIP-191, not a raw digest. See the header.
            return signer.signMessage({ message: { raw: hash } });
        },
    });

    const client = createSmartAccountClient({
        account,
        chain: sepolia,
        bundlerTransport: http(deps.bundlerUrl),
        userOperation: {
            estimateFeesPerGas: bundlerFeeEstimator(publicClient, deps.bundlerUrl),
        },
    });

    return { publicClient, account, client, nonceKey };
}

export interface SendAsRecoveredOwnerParams extends RecoveredOwnerDeps {
    to: Address;
    amount: bigint;
    onProgress?: (message: string) => void;
}

/** Move value out of the recovered account, signing as the key the recovery handed it to. */
export async function sendAsRecoveredOwner(
    params: SendAsRecoveredOwnerParams,
): Promise<{ userOpHash: Hex; transactionHash: Hex }> {
    const { client, nonceKey } = await createRecoveredOwnerClient(params);

    params.onProgress?.(
        `route      validator=${OWNABLE_VALIDATOR_ADDRESS} nonceKey=${toHex(nonceKey)}`,
    );
    params.onProgress?.(`send       ${params.amount} wei to ${params.to}`);

    const userOpHash = await client.sendUserOperation({
        calls: [{ to: params.to, value: params.amount, data: "0x" }],
    });
    params.onProgress?.(`userOp     ${userOpHash} — waiting for the bundler`);

    const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
    if (!receipt.success) {
        throw new Error(
            `The transfer was mined in ${receipt.receipt.transactionHash} but reverted inside the ` +
                "account. Nothing was sent, and the gas is spent.",
        );
    }

    params.onProgress?.(`send       tx=${receipt.receipt.transactionHash}`);
    return { userOpHash, transactionHash: receipt.receipt.transactionHash };
}
