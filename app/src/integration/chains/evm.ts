/**
 * Ethereum Sepolia: a Safe with the Safe7579 adapter, protected by the ERC-7579 `RecoveryModule`.
 *
 * Two addresses, and the difference matters: the seed derives an **EOA**, and the EOA is the sole
 * owner of a **Safe**. The recovery module is an executor installed on the Safe, so the Safe's
 * address is `ChainContext.accountId` — a recovery protects the account the module is installed on,
 * not the key that happens to own it today.
 *
 * The SDK's adapter does the on-chain work; this file supplies what the SDK never provisions: the
 * account. `signer.executor()` wraps the permissionless Safe client in `erc7579Executor`; the sweep
 * drives the recovered account through `toRecoveredOwnerAccount`, which signs through the validator
 * the recovery installed.
 *
 * **To replace:** the private key handling (`exportPrivateKeyHex_DEMO_ONLY`) and the account
 * provider. Whether the smart account comes from permissionless, ZeroDev, Privy or a factory of your
 * own changes nothing below the `accountId` line. **Assumes:** the Safe's first UserOp runs the
 * launchpad deployment out of its own balance, hence the reserves.
 */
import { EvmKeyAdapter, toEvmAddress } from "@nihilium/recovery-key-evm";
import type { HttpRelaySubmitter } from "@nihilium/recovery-core";
import {
    Erc7579RecoveryModuleSettlement,
    eoaExecutor,
    erc7579Executor,
    toRecoveredOwnerAccount,
} from "@nihilium/recovery-settlement-evm";
import { createPublicClient, createWalletClient, http, hexToBytes, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveSecp256k1 } from "@nihilium-demo/keys";
import { EVM_PATH } from "../keys/paths.js";
import { bundlerFeeEstimator, createSafeClient, toDemoSafeAccount } from "./safeAccount.js";
import { asAppSmartAccount, asSdkPublicClient, asSdkWalletClient } from "./sdkClients.js";
import type { Balance, ChainModule, DerivedAccount, ExplorerRef, SendReceipt } from "./types.js";

export const EVM_SEPOLIA_CHAIN_ID = 11155111;
export const EVM_SEPOLIA_ID = "evm-sepolia";

/** 0.002 ETH held back from a send: the account funds its own prefund, and the first UserOp deploys it. */
const GAS_RESERVE_WEI = 2_000_000_000_000_000n;
/** 0.003 ETH held back from a sweep, for the same reason, generous rather than tuned. */
export const SWEEP_RESERVE_WEI = 3_000_000_000_000_000n;

export interface EvmChainOptions {
    rpcUrl: string;
    bundlerUrl: string;
    /** Whose module attestations this account trusts — and part of its address. See `safeAccount.ts`. */
    attester: `0x${string}`;
    relay: HttpRelaySubmitter;
}

export function createEvmSepoliaChain(options: EvmChainOptions): ChainModule {
    const client = createPublicClient({ chain: sepolia, transport: http(options.rpcUrl) }) as PublicClient;
    const namespace = `eip155:${EVM_SEPOLIA_CHAIN_ID}`;

    // The SDK's construction. Everything on-chain — reading the module, installing it, building and
    // signing intents, relaying — is the adapter's; the Safe flavour is the one asymmetry it asks for.
    const settlement = new Erc7579RecoveryModuleSettlement({
        chainId: EVM_SEPOLIA_CHAIN_ID,
        client: asSdkPublicClient(client),
        submitter: options.relay,
        accountFlavour: "safe7579",
    });

    const signDigestWith = (owner: ReturnType<typeof privateKeyToAccount>) => async (digest: Uint8Array) =>
        hexToBytes(await owner.sign({ hash: `0x${bytesToHex(digest)}` }));

    return {
        id: EVM_SEPOLIA_ID,
        label: "Ethereum",
        network: "Sepolia",
        accountKind: "Safe smart account",
        icon: "ethereum",
        // CAIP-2, pinned. An HKDF input — see `ChainModule.namespace`.
        namespace,
        tier: "smart-account",
        keyAdapter: new EvmKeyAdapter(),
        settlement,

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveSecp256k1(seed, EVM_PATH);
            const eoa = toEvmAddress(key.publicKey);
            const ownerHex = `0x${bytesToHex(key.privateKey)}` as Hex;
            const owner = privateKeyToAccount(ownerHex);
            // Built by the shared helper, never inline: this address has to be the one the bundler
            // client and the module installer address.
            const smartAccount = await toDemoSafeAccount({ client, ownerPrivateKeyHex: ownerHex, attester: options.attester });

            return [{
                accountId: smartAccount.address,
                address: smartAccount.address,
                label: "Safe smart account",
                derivationPath: EVM_PATH,
                index: 0,
                signer: {
                    address: eoa,
                    publicKey: key.publicKey,
                    async sign(payload: Uint8Array) {
                        if (payload.length !== 32) throw new Error(`EVM signing takes a 32-byte digest; got ${payload.length} bytes.`);
                        return { algorithm: "secp256k1" as const, bytes: hexToBytes(await owner.sign({ hash: `0x${bytesToHex(payload)}` })) };
                    },
                    // The Safe, driven through its bundler client: what installs the module.
                    async executor() {
                        const safe = await createSafeClient({ rpcUrl: options.rpcUrl, bundlerUrl: options.bundlerUrl, ownerPrivateKeyHex: ownerHex, attester: options.attester });
                        return erc7579Executor({ address: smartAccount.address, client: safe.client, signDigest: signDigestWith(owner), namespace });
                    },
                    // The EOA as a plain sender: what `abort` is sent from, since the module checks
                    // the sender and the abort authority is this key.
                    async keyExecutor() {
                        return eoaExecutor({ walletClient: asSdkWalletClient(createWalletClient({ account: owner, chain: sepolia, transport: http(options.rpcUrl) })), publicClient: asSdkPublicClient(client) });
                    },
                    exportPrivateKeyHex_DEMO_ONLY: () => ownerHex,
                },
            }];
        },

        isValidAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value.trim()),
        // The SDK's own derivation, so a recovered key's address is the one `OwnableValidator` compares against.
        addressOf: (publicKey) => toEvmAddress(publicKey),
        formatAddress: (address, style = "short") => (style === "full" ? address : `${address.slice(0, 6)}…${address.slice(-4)}`),
        explorerUrl: (ref: ExplorerRef) => (ref.kind === "address" ? `https://sepolia.etherscan.io/address/${ref.value}` : `https://sepolia.etherscan.io/tx/${ref.value}`),

        async balanceOf(address: string): Promise<Balance> {
            return { raw: await client.getBalance({ address: address as Address }), decimals: 18, symbol: "ETH", source: "chain" };
        },

        send: {
            reserve: () => GAS_RESERVE_WEI,
            async send({ from, to, amount, onProgress }): Promise<SendReceipt> {
                const { client: safe } = await createSafeClient({ rpcUrl: options.rpcUrl, bundlerUrl: options.bundlerUrl, ownerPrivateKeyHex: from.signer.exportPrivateKeyHex_DEMO_ONLY(), attester: options.attester });
                onProgress?.(`send       ${amount} wei to ${to}`);
                const userOpHash = await safe.sendUserOperation({ calls: [{ to: to as Address, value: amount, data: "0x" }] });
                onProgress?.(`userOp     ${userOpHash} — waiting for the bundler`);
                const receipt = await safe.waitForUserOperationReceipt({ hash: userOpHash });
                if (!receipt.success) {
                    throw new Error(`The transfer was mined in ${receipt.receipt.transactionHash} but reverted inside the account. Nothing was sent, and the gas is spent.`);
                }
                return { hash: receipt.receipt.transactionHash, explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`, fidelity: "onchain" };
            },
        },

        /**
         * `executeRecovery` installed `OwnableValidator` owned by the intent's `newOwner`. It removed
         * nothing: the Safe's own owner list is untouched and the lost key can still act through
         * `execTransaction`. So moving the balance somewhere the old key cannot reach is a second,
         * separate act — signed by the destination key through the validator the recovery installed.
         */
        sweep: {
            async sweep({ accountId, to, newOwnerPrivateKeyHex, amount, onProgress }) {
                const account = accountId as Address;
                const balance = await client.getBalance({ address: account });
                const moved = amount ?? (balance > SWEEP_RESERVE_WEI ? balance - SWEEP_RESERVE_WEI : 0n);
                if (moved <= 0n) {
                    throw new Error(`Balance of ${balance} wei is too low to pay its own fee. Send a little ETH to ${account} and move again.`);
                }
                const signer = privateKeyToAccount((newOwnerPrivateKeyHex.startsWith("0x") ? newOwnerPrivateKeyHex : `0x${newOwnerPrivateKeyHex}`) as Hex);
                const recovered = await toRecoveredOwnerAccount({ client: asSdkPublicClient(client), account, chainId: EVM_SEPOLIA_CHAIN_ID, signer });
                const bundler = createSmartAccountClient({
                    account: asAppSmartAccount(recovered.account),
                    chain: sepolia,
                    bundlerTransport: http(options.bundlerUrl),
                    userOperation: { estimateFeesPerGas: bundlerFeeEstimator(client, options.bundlerUrl) },
                });
                onProgress?.(`route      validator=${recovered.validator} nonceKey=0x${recovered.nonceKey.toString(16)}`);
                onProgress?.(`send       ${moved} wei to ${to}`);
                const userOpHash = await bundler.sendUserOperation({ calls: [{ to: to as Address, value: moved, data: "0x" }] });
                onProgress?.(`userOp     ${userOpHash} — waiting for the bundler`);
                const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
                if (!receipt.success) {
                    throw new Error(`The transfer was mined in ${receipt.receipt.transactionHash} but reverted inside the account. Nothing was sent, and the gas is spent.`);
                }
                onProgress?.(`send       tx=${receipt.receipt.transactionHash}`);
                return { hash: receipt.receipt.transactionHash, moved };
            },
        },
    };
}
