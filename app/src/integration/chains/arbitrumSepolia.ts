/**
 * Arbitrum Sepolia: a plain EOA, protected through an EIP-7702 delegation.
 *
 * The Sepolia module above protects a Safe, which means an account the user had to move into. This
 * chain protects the account they already have. The EOA delegates its code to
 * `Eip7702RecoveryAccount` once, and from then on it *is* the recovery account: `address(this)` is
 * the EOA, and the recovery state lives in the EOA's own storage. So `accountId` and `address` are
 * the same string, the EOA, and nothing here needs a bundler or a counterfactual address.
 *
 * The key is `EVM_PATH`, the same one that owns the Sepolia Safe. That is safe because the namespace
 * differs: `eip155:421614` is an HKDF input, so this chain's recovery key is unrelated to Sepolia's
 * even for the same seed.
 *
 * **What a real app must replace:** the private key handling (`exportPrivateKeyHex_DEMO_ONLY`) and
 * the RPC. **Assumes:** the implementation this EOA delegates to accepts plain ETH transfers.
 * `settlement/eip7702/preflight.ts` checks that before any delegation, because an EOA delegated to
 * code without `receive()` can never be paid again.
 */
import { EvmKeyAdapter, toEvmAddress } from "@nihilium/recovery-key-evm";
import { createPublicClient, createWalletClient, http, hexToBytes, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveSecp256k1 } from "@nihilium-demo/keys";
import { EVM_PATH } from "../keys/paths.js";
import type { Balance, ChainModule, DerivedAccount, ExplorerRef, SendReceipt } from "./types.js";

/** The chain id, and the CAIP-2 namespace built from it. The namespace is pinned, never derived. */
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ARBITRUM_SEPOLIA_ID = "arbitrum-sepolia";

/**
 * Held back from a "send everything" so the transfer can pay its own fee.
 *
 * Far smaller than the Safe's reserve: a plain transfer from an EOA costs 21,000 gas at an L2 price,
 * with no deployment and no UserOp prefund riding on it.
 */
const GAS_RESERVE_WEI = 100_000_000_000_000n; // 0.0001 ETH

const EXPLORER = "https://sepolia.arbiscan.io";

export interface ArbitrumSepoliaChainOptions {
    rpcUrl: string;
}

export function createArbitrumSepoliaChain(options: ArbitrumSepoliaChainOptions): ChainModule {
    const client = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(options.rpcUrl),
    }) as PublicClient;

    return {
        id: ARBITRUM_SEPOLIA_ID,
        label: "Arbitrum",
        network: "Arbitrum Sepolia",
        icon: "arbitrum",
        // CAIP-2, pinned. An HKDF input — see `ChainModule.namespace`.
        namespace: `eip155:${ARBITRUM_SEPOLIA_CHAIN_ID}`,
        // Core's `Tier` has no value for a delegated EOA. It has every veto capability a smart
        // account has, so that is the honest one of the two. See docs/sdk-proposals.md §4.
        tier: "smart-account",
        keyAdapter: new EvmKeyAdapter(),

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveSecp256k1(seed, EVM_PATH);
            const eoa = toEvmAddress(key.publicKey);
            const owner = privateKeyToAccount(`0x${bytesToHex(key.privateKey)}`);

            return [
                {
                    // The EOA twice: after delegation it is both the account recovery protects and
                    // the address funds are sent to.
                    accountId: eoa,
                    address: eoa,
                    label: "Account (7702)",
                    derivationPath: EVM_PATH,
                    index: 0,
                    signer: {
                        address: eoa,
                        publicKey: key.publicKey,
                        async sign(payload: Uint8Array) {
                            if (payload.length !== 32) {
                                throw new Error(
                                    `EVM signing takes a 32-byte digest; got ${payload.length} bytes.`,
                                );
                            }
                            const hex = await owner.sign({ hash: `0x${bytesToHex(payload)}` });
                            return { algorithm: "secp256k1" as const, bytes: hexToBytes(hex) };
                        },
                        exportPrivateKeyHex_DEMO_ONLY: () => `0x${bytesToHex(key.privateKey)}`,
                    },
                },
            ];
        },

        isValidAddress(value) {
            return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
        },

        addressOfPublicKey: (publicKey) => toEvmAddress(publicKey),

        formatAddress(address, style = "short") {
            return style === "full" ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
        },

        explorerUrl(ref: ExplorerRef) {
            return ref.kind === "address"
                ? `${EXPLORER}/address/${ref.value}`
                : `${EXPLORER}/tx/${ref.value}`;
        },

        async balanceOf(address: string): Promise<Balance> {
            const raw = await client.getBalance({ address: address as `0x${string}` });
            return { raw, decimals: 18, symbol: "ETH", source: "chain" };
        },

        settlement: null,

        send: {
            reserve: () => GAS_RESERVE_WEI,

            // An ordinary transaction, delegated or not: outgoing transactions from an EOA never run
            // its delegated code. Only calls *into* the EOA do.
            async send({ from, to, amount, onProgress }): Promise<SendReceipt> {
                const account = privateKeyToAccount(
                    from.signer.exportPrivateKeyHex_DEMO_ONLY() as `0x${string}`,
                );
                const wallet = createWalletClient({
                    account,
                    chain: arbitrumSepolia,
                    transport: http(options.rpcUrl),
                });
                onProgress?.(`send       ${amount} wei to ${to}`);
                const hash = await wallet.sendTransaction({
                    to: to as `0x${string}`,
                    value: amount,
                });
                onProgress?.(`tx         ${hash} — waiting for inclusion`);
                const receipt = await client.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(`The transfer was mined in ${hash} but reverted. Nothing was sent.`);
                }
                return { hash, explorerUrl: `${EXPLORER}/tx/${hash}`, fidelity: "onchain" };
            },
        },
    };
}
