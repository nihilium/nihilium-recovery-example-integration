/**
 * Arbitrum Sepolia: a plain EOA, protected through an EIP-7702 delegation to `Eip7702RecoveryAccount`.
 *
 * The Sepolia module protects a Safe, which means an account the user had to move into. This chain
 * protects the account they already have: the EOA delegates its code once, and from then on it *is*
 * the recovery account — `accountId` and `address` are the same string, and nothing here needs a
 * bundler. The SDK's adapter reads the EOA's own storage, builds the delegation and the two-signature
 * registration, and relays intents; this file supplies the EOA as a viem wallet client.
 *
 * **To replace:** the private key handling and the RPC. **Assumes:** the implementation this EOA
 * delegates to accepts plain ETH transfers; the adapter's preflight refuses one that does not.
 */
import { EvmKeyAdapter, toEvmAddress } from "@nihilium/recovery-key-evm";
import type { HttpRelaySubmitter } from "@nihilium/recovery-core";
import { Eip7702RecoveryAccountSettlement, createEip7702Reader, eoaExecutor } from "@nihilium/recovery-settlement-evm";
import { createPublicClient, createWalletClient, http, hexToBytes, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveSecp256k1 } from "@nihilium-demo/keys";
import { EVM_PATH } from "../keys/paths.js";
import { asSdkPublicClient, asSdkWalletClient } from "./sdkClients.js";
import type { Balance, ChainModule, DerivedAccount, ExplorerRef, SendReceipt } from "./types.js";

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ARBITRUM_SEPOLIA_ID = "arbitrum-sepolia";

/** 0.0001 ETH: a plain transfer from an EOA at an L2 price, with no deployment riding on it. */
const GAS_RESERVE_WEI = 100_000_000_000_000n;
const EXPLORER = "https://sepolia.arbiscan.io";

export interface ArbitrumSepoliaChainOptions {
    rpcUrl: string;
    relay: HttpRelaySubmitter;
}

export function createArbitrumSepoliaChain(options: ArbitrumSepoliaChainOptions): ChainModule {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(options.rpcUrl) }) as PublicClient;
    const namespace = `eip155:${ARBITRUM_SEPOLIA_CHAIN_ID}`;
    const settlement = new Eip7702RecoveryAccountSettlement({ chainId: ARBITRUM_SEPOLIA_CHAIN_ID, client: asSdkPublicClient(client), submitter: options.relay });
    const walletFor = (hex: Hex) => createWalletClient({ account: privateKeyToAccount(hex), chain: arbitrumSepolia, transport: http(options.rpcUrl) });

    return {
        id: ARBITRUM_SEPOLIA_ID,
        label: "Arbitrum",
        network: "Arbitrum Sepolia",
        accountKind: "EIP-7702 account",
        icon: "arbitrum",
        namespace,
        // The tier core has for this: every veto capability a smart account has, on an EOA.
        tier: "delegated-eoa",
        keyAdapter: new EvmKeyAdapter(),
        settlement,

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveSecp256k1(seed, EVM_PATH);
            const eoa = toEvmAddress(key.publicKey);
            const ownerHex = `0x${bytesToHex(key.privateKey)}` as Hex;
            const owner = privateKeyToAccount(ownerHex);
            // The EOA as a plain sender and as the account are the same thing here.
            const executor = async () => eoaExecutor({ walletClient: asSdkWalletClient(walletFor(ownerHex)), publicClient: asSdkPublicClient(client) });

            return [{
                accountId: eoa,
                address: eoa,
                label: "EIP-7702 account",
                derivationPath: EVM_PATH,
                index: 0,
                signer: {
                    address: eoa,
                    publicKey: key.publicKey,
                    async sign(payload: Uint8Array) {
                        if (payload.length !== 32) throw new Error(`EVM signing takes a 32-byte digest; got ${payload.length} bytes.`);
                        return { algorithm: "secp256k1" as const, bytes: hexToBytes(await owner.sign({ hash: `0x${bytesToHex(payload)}` })) };
                    },
                    executor,
                    keyExecutor: executor,
                    exportPrivateKeyHex_DEMO_ONLY: () => ownerHex,
                },
            }];
        },

        isValidAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value.trim()),
        addressOf: (publicKey) => toEvmAddress(publicKey),
        formatAddress: (address, style = "short") => (style === "full" ? address : `${address.slice(0, 6)}…${address.slice(-4)}`),
        explorerUrl: (ref: ExplorerRef) => (ref.kind === "address" ? `${EXPLORER}/address/${ref.value}` : `${EXPLORER}/tx/${ref.value}`),

        async balanceOf(address: string): Promise<Balance> {
            return { raw: await client.getBalance({ address: address as Address }), decimals: 18, symbol: "ETH", source: "chain" };
        },

        send: {
            reserve: () => GAS_RESERVE_WEI,
            // An ordinary transaction, delegated or not: outgoing transactions from an EOA never run
            // its delegated code. Only calls *into* the EOA do.
            async send({ from, to, amount, onProgress }): Promise<SendReceipt> {
                const wallet = walletFor(from.signer.exportPrivateKeyHex_DEMO_ONLY() as Hex);
                onProgress?.(`send       ${amount} wei to ${to}`);
                const hash = await wallet.sendTransaction({ to: to as Address, value: amount });
                onProgress?.(`tx         ${hash} — waiting for inclusion`);
                const receipt = await client.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") throw new Error(`The transfer was mined in ${hash} but reverted. Nothing was sent.`);
                return { hash, explorerUrl: `${EXPLORER}/tx/${hash}`, fidelity: "onchain" };
            },
        },

        /**
         * `executeRecovery` set the account's stored `owner` to the intent's `newOwner`. The new owner
         * signs `hashExecute`, the relayer submits and pays the gas, and the value comes out of the
         * EOA's own balance; nothing is held back.
         */
        sweep: {
            async sweep({ accountId, to, newOwnerPrivateKeyHex, amount, onProgress }) {
                const account = accountId as Address;
                const newOwner = privateKeyToAccount((newOwnerPrivateKeyHex.startsWith("0x") ? newOwnerPrivateKeyHex : `0x${newOwnerPrivateKeyHex}`) as Hex);
                // Checked rather than assumed: a signature from anyone but the current owner reverts,
                // and "BadSignature" says nothing about the execute that has not landed yet.
                const current = await createEip7702Reader(asSdkPublicClient(client), account, settlement.implementation, namespace).configOf();
                if (current.currentOwner.toLowerCase() !== newOwner.address.toLowerCase()) {
                    throw new Error(`This account's owner is still ${current.currentOwner}. Execute the recovery first.`);
                }
                const balance = await client.getBalance({ address: account });
                const moved = amount ?? balance;
                if (moved <= 0n) throw new Error(`${account} holds nothing to move.`);
                const result = await settlement.executeAsOwner({
                    account: { namespace, accountId: account },
                    calls: [{ target: to as Address, value: moved, data: "0x" }],
                    owner: { signDigest: async (digest) => hexToBytes(await newOwner.sign({ hash: `0x${bytesToHex(digest)}` })) },
                    ...(onProgress ? { onProgress } : {}),
                });
                onProgress?.(`sweep      tx=${result.hash} — ${moved} wei to ${to}`);
                return { hash: result.hash, moved };
            },
        },
    };
}
