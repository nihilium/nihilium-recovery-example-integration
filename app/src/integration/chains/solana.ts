/**
 * Solana devnet — and the chain where "protect this wallet" is not a thing that can be done.
 *
 * **A Solana keypair's address *is* its public key.** There is no EIP-7702 analogue, no code to
 * install at an existing address, and therefore no way to retrofit recovery onto one: a lost key is
 * a permanently lost address. What recovery protects is a **program-owned vault**, created in
 * advance, and only what is inside it. A wallet already holding funds at a plain address has to move
 * them; nothing rescues the address itself.
 *
 * So this module returns the keypair as the **creator/owner** — the thing that signs, pays, and
 * cannot be recovered. The protected account is a vault PDA, which does not exist until
 * `create_vault` runs and whose address depends on the SDK's vault id, so it is derived in
 * `settlement/solana/addresses.ts` rather than here. Before a vault exists there is genuinely no
 * protected account to show, and showing one would be the lie.
 *
 * **To replace:** `send`'s vault lookup, if your wallet tracks the vault elsewhere. The program is
 * live on devnet at `DaLebS3k5gD1k42uGU6LPnSP9qTNwYxaKqLQBb7BqgkG`.
 * **Assumes:** the namespace comes from `SOLANA_NAMESPACE` and never from a literal — every recovery
 * key derived for this chain depends on it byte for byte, and `solana:devnet` is not a chain id.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { SOLANA_NAMESPACE, SolanaKeyAdapter, toSolanaAddress } from "@nihilium/recovery-key-solana";
import { Connection, PublicKey } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveEd25519 } from "@nihilium-demo/keys";
import { SOLANA_PATH } from "../keys/paths.js";
import type {
    Balance,
    ChainModule,
    DerivedAccount,
    ExplorerRef,
    SendReceipt,
} from "./types.js";
import { solanaVaultAddresses } from "../recovery/settlement/solana/addresses.js";
import { createVaultProgram, keypairFromSecret } from "../recovery/settlement/solana/program.js";
import { executeTransfer } from "../recovery/settlement/solana/vault.js";
import { loadFeePayer } from "../recovery/settlement/solana/submit.js";

/**
 * Nothing is held back from a Solana send.
 *
 * The fee comes from the relayer, not from the vault — so unlike the EVM smart account, which funds
 * its own prefund out of the balance being sent, the protected balance here is fully sendable. The
 * reserve is zero and says so rather than being a magic number nobody can explain.
 */
const NO_RESERVE = 0n;

export interface SolanaChainOptions {
    /** A devnet RPC. Queried for real — there are no simulated balances on this chain any more. */
    rpcUrl: string;
    /**
     * Where the fee payer lives, so a send costs the owner key nothing.
     *
     * Without it the owner pays its own fee, and the owner is the account this demo deliberately
     * never funds — which surfaces as Solana's rawest error, "attempt to debit an account but found
     * no record of a prior credit", from a wallet whose vault is full.
     */
    serverUrl?: string;
}

export function createSolanaDevnetChain(options: SolanaChainOptions): ChainModule {
    // `confirmed` rather than `finalized`: a demo that waits ~13s per read to show a balance reads
    // as broken, and a balance is not a thing worth waiting for finality over.
    const connection = new Connection(options.rpcUrl, "confirmed");

    return {
        id: "solana-devnet",
        label: "Solana · devnet",
        icon: "solana",
        // Never hand-written. CAIP-2 for Solana is the truncated genesis hash, not the cluster
        // name — `solana:devnet` is not a chain id, it just looks like one, and it would have sealed
        // perfectly happily. The namespace is a KDF input, so a wrong value is not a bug that gets
        // fixed later: it is a vault whose keys nothing on that chain will ever accept.
        namespace: SOLANA_NAMESPACE.devnet,
        tier: "smart-account",
        keyAdapter: new SolanaKeyAdapter(),

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveEd25519(seed, SOLANA_PATH);
            const owner = toSolanaAddress(key.publicKey);
            // Derivable from the seed alone, and counterfactual exactly like the EVM smart account:
            // the address exists as an answer long before `create_vault` puts anything at it. That
            // only became true once the PDA seed stopped depending on which gate guards the vault —
            // before that this had to wait for a ledger row, and the card had nothing to show.
            const addresses = solanaVaultAddresses({ cluster: "devnet", creator: owner });
            return [
                {
                    // The vault, not the key. `ChainContext.accountId` is what recovery binds, and
                    // a keypair's address is its public key — unrecoverable by construction.
                    accountId: addresses.vault.toBase58(),
                    // What the user sees and sends to. The vault is two accounts: this one holds
                    // the lamports, `accountId` above is the identity the program acts on, and
                    // nothing can move value out of that one.
                    address: addresses.vaultSol.toBase58(),
                    label: "Recovery vault",
                    // The key behind the account, as on EVM — where this column is the EOA's path
                    // and not the Safe's, because a Safe has no derivation path either.
                    derivationPath: SOLANA_PATH,
                    index: 0,
                    signer: {
                        address: owner,
                        publicKey: key.publicKey,
                        async sign(payload: Uint8Array) {
                            // ed25519 signs the message, not a digest — the opposite of the EVM
                            // adapter, and the reason `sign` is per-chain rather than shared.
                            return {
                                algorithm: "ed25519" as const,
                                bytes: ed25519.sign(payload, key.privateKey),
                            };
                        },
                        exportPrivateKeyHex_DEMO_ONLY: () => `0x${bytesToHex(key.privateKey)}`,
                    },
                },
            ];
        },

        isValidAddress(value) {
            // Decoded, not pattern-matched: base58 has no fixed length and the alphabet excludes
            // characters a regex would have to enumerate. 32 bytes is what an address is.
            try {
                return base58.decode(value.trim()).length === 32;
            } catch {
                return false;
            }
        },

        formatAddress(address, style = "short") {
            return style === "full" ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
        },

        explorerUrl(ref: ExplorerRef) {
            // The cluster query is not optional: without it the explorer shows mainnet, where these
            // addresses have no history and the page reads as "nothing ever happened".
            const base = ref.kind === "address" ? "address" : "tx";
            return `https://explorer.solana.com/${base}/${ref.value}?cluster=devnet`;
        },

        async balanceOf(address: string): Promise<Balance> {
            const lamports = await connection.getBalance(new PublicKey(address), "confirmed");
            return { raw: BigInt(lamports), decimals: 9, symbol: "SOL", source: "chain" };
        },

        // Still null: `SettlementBinding` is the SDK's own register/initiate/veto/status surface,
        // and the Solana equivalents are driven directly from `settlement/solana/` rather than
        // through it. Wiring the binding is the next step, not a missing capability.
        settlement: null,

        send: {
            // Somebody else pays the fee, so the vault's whole balance is sendable.
            reserve: () => NO_RESERVE,

            async send({ from, to, amount, onProgress }): Promise<SendReceipt> {
                // Derived, not looked up. The vault's address is a function of the owner key, so
                // there is nothing to fetch and nothing that can be out of step with the ledger.
                const addresses = solanaVaultAddresses({
                    cluster: "devnet",
                    creator: from.signer.address,
                });

                const ctx = createVaultProgram({
                    rpcUrl: options.rpcUrl,
                    cluster: "devnet",
                    payer: keypairFromSecret(from.signer.exportPrivateKeyHex_DEMO_ONLY()),
                });

                // Checked before sending, because the program's failure for an empty vault is
                // "attempt to debit an account but found no record of a prior credit" — true, and
                // about an account the user has never been shown.
                const held = BigInt(await connection.getBalance(addresses.vaultSol, "confirmed"));
                if (held < amount) {
                    throw new Error(
                        `This vault holds ${held} lamports and the transfer asks for ${amount}. ` +
                            `Send SOL to ${addresses.vaultSol.toBase58()} to protect it first — ` +
                            "the owner key's balance is not the vault's.",
                    );
                }

                // The relayer pays, the owner signs. The owner key is never funded in this demo,
                // and a send that quietly needed it to be would contradict the whole arrangement.
                const via = options.serverUrl ? await loadFeePayer(options.serverUrl) : null;
                onProgress?.(
                    via === null
                        ? "feepayer   unavailable — this send is paid by the owner key"
                        : "feepayer   the server pays; the owner key needs no SOL",
                );

                const signature = await executeTransfer(ctx, {
                    addresses,
                    to,
                    lamports: amount,
                    ...(via ? { via } : {}),
                    ...(onProgress ? { onProgress } : {}),
                });

                return {
                    hash: signature,
                    explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
                    fidelity: "onchain",
                };
            },
        },
    };
}

/** Exported for the address test: base58 is the encoding, and the test pins it independently. */
export const solanaBase58 = base58;
