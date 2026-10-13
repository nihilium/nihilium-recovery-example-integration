/**
 * Solana devnet — and the chain where "protect this wallet" is not a thing that can be done.
 *
 * **A Solana keypair's address *is* its public key.** There is no code to install at an existing
 * address, so a lost key is a permanently lost address. What recovery protects is a
 * **program-owned vault**, created in advance, and only what is inside it. This module returns the
 * keypair as the **creator/owner** — the thing that signs and cannot be recovered — and the vault PDA
 * as `accountId`, derived from the seed alone, counterfactually, exactly like the EVM smart account.
 *
 * The SDK's adapter creates the vault, registers the guardian with the incoming key's signature,
 * relays intents and moves lamports. This file supplies the owner keypair wrapped in
 * `solanaOwnerExecutor`, with the relayer as fee payer so the owner never needs SOL.
 *
 * **To replace:** the key handling. **Assumes:** the namespace comes from `SOLANA_NAMESPACE` and
 * never from a literal — `solana:devnet` is not a chain id, and this is a KDF input.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AccountExecutor, HttpRelaySubmitter } from "@nihilium/recovery-core";
import { SOLANA_NAMESPACE, SolanaKeyAdapter, toSolanaAddress } from "@nihilium/recovery-key-solana";
import {
    SolanaRecoveryVaultSettlement,
    programIdFor,
    solanaOwnerExecutor,
    solanaVaultAddresses,
} from "@nihilium/recovery-settlement-solana";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { deriveEd25519 } from "@nihilium-demo/keys";
import { SOLANA_PATH } from "../keys/paths.js";
import type { Balance, ChainModule, DerivedAccount, ExplorerRef, SendReceipt } from "./types.js";

export const SOLANA_DEVNET_ID = "solana-devnet";

/**
 * The program's 16-byte vault seed, as this demo has always derived it — **not** the SDK's default.
 *
 * The PDA is the account, and this constant is part of its address: changing it would move every
 * vault this demo ever created. The SDK's `DEFAULT_VAULT_SEED` is a different constant for a fresh
 * integration; a wallet keeps whichever it started with. The server passes the same bytes.
 */
export const DEMO_VAULT_SEED: Uint8Array = sha256(new TextEncoder().encode("nihilium-recovery-demo:vault:v1")).slice(0, 16);

/** Nothing is held back from a Solana send: the relayer pays the fee, so the vault's whole balance is sendable. */
const NO_RESERVE = 0n;

export interface SolanaChainOptions {
    rpcUrl: string;
    relay: HttpRelaySubmitter;
}

/** SLIP-0010 yields the 32-byte seed; `fromSeed` expands it to the 64-byte secret key web3.js wants. */
export function keypairFromSecret(hex: string): Keypair {
    return Keypair.fromSeed(hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex));
}

export function createSolanaDevnetChain(options: SolanaChainOptions): ChainModule {
    // `confirmed` rather than `finalized`: a balance is not a thing worth waiting for finality over.
    const connection = new Connection(options.rpcUrl, "confirmed");
    const namespace = SOLANA_NAMESPACE.devnet;
    const programId = programIdFor("devnet");
    const settlement = new SolanaRecoveryVaultSettlement({ cluster: "devnet", connection, submitter: options.relay, vaultSeed: DEMO_VAULT_SEED });
    const addressesFor = (creator: string) => solanaVaultAddresses({ programId, creator: new PublicKey(creator), vaultSeed: DEMO_VAULT_SEED });

    /**
     * The owner keypair as the SDK drives it, with the relayer co-signing fees when the server offers
     * one. `null` from `config()` means a server started without Solana: the owner pays, and the
     * transcript says so, rather than the demo quietly needing SOL it never funded.
     */
    const executorFor = async (owner: Keypair): Promise<AccountExecutor> => {
        const published = await options.relay.config(namespace).catch(() => null);
        return solanaOwnerExecutor({
            connection,
            owner,
            namespace,
            ...(published === null ? {} : { feePayer: { submitter: options.relay, relayer: published.relayer } }),
        });
    };

    return {
        id: SOLANA_DEVNET_ID,
        label: "Solana",
        network: "Devnet",
        accountKind: "Nihilium recovery vault",
        icon: "solana",
        namespace,
        tier: "smart-account",
        keyAdapter: new SolanaKeyAdapter(),
        settlement,

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveEd25519(seed, SOLANA_PATH);
            const owner = toSolanaAddress(key.publicKey);
            const keypair = keypairFromSecret(bytesToHex(key.privateKey));
            const addresses = addressesFor(owner);
            const executor = () => executorFor(keypair);
            return [{
                // The vault, not the key. `ChainContext.accountId` is what recovery binds.
                accountId: addresses.vault.toBase58(),
                // What the user sees and sends to: the PDA holding the lamports.
                address: addresses.vaultSol.toBase58(),
                label: "Nihilium recovery vault",
                derivationPath: SOLANA_PATH,
                index: 0,
                signer: {
                    address: owner,
                    publicKey: key.publicKey,
                    async sign(payload: Uint8Array) {
                        // ed25519 signs the message, not a digest — the opposite of the EVM adapter.
                        return { algorithm: "ed25519" as const, bytes: ed25519.sign(payload, key.privateKey) };
                    },
                    executor,
                    keyExecutor: executor,
                    exportPrivateKeyHex_DEMO_ONLY: () => `0x${bytesToHex(key.privateKey)}`,
                },
            }];
        },

        isValidAddress(value) {
            try {
                return base58.decode(value.trim()).length === 32;
            } catch {
                return false;
            }
        },
        addressOf: (publicKey) => toSolanaAddress(publicKey),
        formatAddress: (address, style = "short") => (style === "full" ? address : `${address.slice(0, 4)}…${address.slice(-4)}`),
        explorerUrl: (ref: ExplorerRef) => `https://explorer.solana.com/${ref.kind === "address" ? "address" : "tx"}/${ref.value}?cluster=devnet`,

        async balanceOf(address: string): Promise<Balance> {
            const lamports = await connection.getBalance(new PublicKey(address), "confirmed");
            return { raw: BigInt(lamports), decimals: 9, symbol: "SOL", source: "chain" };
        },

        send: {
            reserve: () => NO_RESERVE,
            async send({ from, to, amount, onProgress }): Promise<SendReceipt> {
                const addresses = addressesFor(from.signer.address);
                const held = BigInt(await connection.getBalance(addresses.vaultSol, "confirmed"));
                if (held < amount) {
                    throw new Error(`Vault holds ${held} lamports; the transfer needs ${amount}. Send SOL to ${addresses.vaultSol.toBase58()}.`);
                }
                const result = await settlement.executeTransfer({
                    account: { namespace, accountId: addresses.vault.toBase58(), signerAddress: from.signer.address },
                    owner: await from.signer.executor(),
                    to,
                    lamports: amount,
                    ...(onProgress ? { onProgress } : {}),
                });
                return { hash: result.hash, explorerUrl: `https://explorer.solana.com/tx/${result.hash}?cluster=devnet`, fidelity: "onchain" };
            },
        },

        /**
         * `execute_recovery` rotated `vault.owner`; the previous owner lost control outright. Moving
         * the lamports is the rotated owner's `execute_transfer`, paid for by the relayer: the new
         * owner is a fresh key with no SOL, and a sweep that needed it funded would fail in exactly
         * the case this exists for.
         */
        sweep: {
            async sweep({ accountId, signerAddress, to, newOwnerPrivateKeyHex, amount, onProgress }) {
                if (signerAddress === undefined) {
                    throw new Error(`Vault record has no creator for Solana vault ${accountId}. Re-protect this chain.`);
                }
                const addresses = addressesFor(signerAddress);
                const held = BigInt(await connection.getBalance(addresses.vaultSol, "confirmed"));
                const moved = amount ?? held - NO_RESERVE;
                if (moved <= 0n) throw new Error(`The vault at ${addresses.vaultSol.toBase58()} holds nothing to move.`);
                const result = await settlement.executeTransfer({
                    account: { namespace, accountId, signerAddress },
                    owner: await executorFor(keypairFromSecret(newOwnerPrivateKeyHex)),
                    to,
                    lamports: moved,
                    ...(onProgress ? { onProgress } : {}),
                });
                return { hash: result.hash, moved };
            },
        },
    };
}

/** Exported for the address test: base58 is the encoding, and the test pins it independently. */
export const solanaBase58 = base58;
