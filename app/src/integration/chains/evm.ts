/**
 * Ethereum Sepolia — the only chain here whose settlement is real.
 *
 * Two addresses, and the difference matters for recovery: the seed derives an **EOA**, and the EOA
 * is the sole owner of a **Safe** carrying the Safe7579 adapter (ERC-7579). The recovery module is
 * an executor installed on the Safe, so the Safe's address is what goes in `ChainContext.accountId`
 * — a recovery protects the account the module is installed on, not the key that happens to own it
 * today.
 *
 * A Safe has **two** control paths and only one of them is ERC-7579: the owners' `execTransaction`,
 * and validators reached through the EntryPoint. A recovery installs a validator, so it adds the
 * second; it never removes the first. See `recoveredOwner.ts`.
 *
 * What a real app must replace: the private key handling (`exportPrivateKeyHex_DEMO_ONLY`) and the
 * account provider. Whether the smart account comes from permissionless, ZeroDev, Privy or a
 * factory of your own changes nothing below the `accountId` line.
 */
import { EvmKeyAdapter, toEvmAddress } from "@nihilium/recovery-key-evm";
import { createPublicClient, http, hexToBytes, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveSecp256k1 } from "@nihilium-demo/keys";
import { EVM_PATH } from "../keys/paths.js";
import { createSafeClient, toDemoSafeAccount } from "./safeAccount.js";
import type {
    Balance,
    ChainModule,
    DerivedAccount,
    ExplorerRef,
    SendReceipt,
} from "./types.js";

/**
 * Held back from a "send everything" so the operation can pay for itself.
 *
 * 0.002 ETH. The account has no paymaster, so it funds its own prefund out of the same balance; a
 * Max button that offered the whole lot would be rejected during validation every time, after the
 * amount had already been shown as acceptable.
 *
 * Twice what a Kernel account needed, because the Safe's first UserOp runs the whole launchpad
 * deployment — proxy, module setup, singleton swap — out of this same balance.
 */
const GAS_RESERVE_WEI = 2_000_000_000_000_000n;

export interface EvmChainOptions {
    rpcUrl: string;
    /** Where UserOps go. Sending and installing the recovery module both need one. */
    bundlerUrl: string;
    /** Whose module attestations this account trusts — and part of its address. See `safeAccount.ts`. */
    attester: `0x${string}`;
    /** Sepolia. The namespace is pinned below rather than derived from this, deliberately. */
    chainId?: 11155111;
}

export function createEvmSepoliaChain(options: EvmChainOptions): ChainModule {
    const client = createPublicClient({
        chain: sepolia,
        transport: http(options.rpcUrl),
    }) as PublicClient;

    return {
        id: "evm-sepolia",
        label: "EVM · Sepolia",
        icon: "ethereum",
        // CAIP-2, pinned. An HKDF input — see `ChainModule.namespace`.
        namespace: "eip155:11155111",
        tier: "smart-account",
        keyAdapter: new EvmKeyAdapter(),

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveSecp256k1(seed, EVM_PATH);
            // Reused from the SDK rather than re-implemented: one checksum implementation, and the
            // same one that turns a recovered `recoveryPubKey` into the module's `recoveryOwner`.
            const eoa = toEvmAddress(key.publicKey);
            const owner = privateKeyToAccount(`0x${bytesToHex(key.privateKey)}`);

            // Built by the shared helper, never inline: the address this returns has to be the same
            // one the bundler client and the module installer address, and two constructions that
            // must agree is a version bump away from silently disagreeing.
            const smartAccount = await toDemoSafeAccount({
                client,
                ownerPrivateKeyHex: `0x${bytesToHex(key.privateKey)}`,
                attester: options.attester,
            });

            return [
                {
                    accountId: smartAccount.address,
                    address: smartAccount.address,
                    label: "Safe smart account",
                    derivationPath: EVM_PATH,
                    index: 0,
                    signer: {
                        address: eoa,
                        publicKey: key.publicKey,
                        async sign(payload: Uint8Array) {
                            // Matches `EvmKeyAdapter.sign`: a 32-byte digest, already hashed. Anything
                            // else is rejected rather than padded, because padding a mis-sized digest
                            // produces a valid signature over the wrong thing.
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

        formatAddress(address, style = "short") {
            return style === "full" ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
        },

        explorerUrl(ref: ExplorerRef) {
            return ref.kind === "address"
                ? `https://sepolia.etherscan.io/address/${ref.value}`
                : `https://sepolia.etherscan.io/tx/${ref.value}`;
        },

        async balanceOf(address: string): Promise<Balance> {
            const raw = await client.getBalance({ address: address as `0x${string}` });
            return { raw, decimals: 18, symbol: "ETH", source: "chain" };
        },

        // Real settlement lands with the EVM binding; until then this chain honestly has none.
        settlement: null,

        send: {
            reserve: () => GAS_RESERVE_WEI,

            async send({ from, to, amount, onProgress }): Promise<SendReceipt> {
                const { client } = await createSafeClient({
                    rpcUrl: options.rpcUrl,
                    bundlerUrl: options.bundlerUrl,
                    ownerPrivateKeyHex: from.signer.exportPrivateKeyHex_DEMO_ONLY(),
                    attester: options.attester,
                });

                onProgress?.(`send       ${amount} wei to ${to}`);
                const userOpHash = await client.sendUserOperation({
                    calls: [{ to: to as `0x${string}`, value: amount, data: "0x" }],
                });
                onProgress?.(`userOp     ${userOpHash} — waiting for the bundler`);

                const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
                // Mined is not the same as succeeded: a UserOp can revert inside the account and the
                // bundler is paid either way.
                if (!receipt.success) {
                    throw new Error(
                        `The transfer was mined in ${receipt.receipt.transactionHash} but reverted ` +
                            "inside the account. Nothing was sent, and the gas is spent.",
                    );
                }

                return {
                    hash: receipt.receipt.transactionHash,
                    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`,
                    fidelity: "onchain",
                };
            },
        },
    };
}
