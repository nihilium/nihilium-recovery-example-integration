/**
 * Moving a recovered Solana vault: submit the intent, wait, rotate the owner, send the lamports on.
 *
 * Plain functions for the same reason as the EVM twin — the timelock sits between the steps and can
 * outlast the session, so nothing here may depend on a render.
 *
 * **What `execute_recovery` does here, and how it differs from EVM.** It rotates `vault.owner`. The
 * previous owner loses control outright, unlike EVM where the recovery *adds* a validator and leaves
 * the old path installed. It moves no lamports and makes no CPI, so taking the vault back and
 * emptying it stay two separate acts on both chains — just for different reasons.
 *
 * **To replace:** the relayer routes. **Assumes:** `chainRecord.signerAddress` holds the vault's
 * creator. The PDA is seeded by it and the seed is not reversible, so a recovery run from a
 * different seed — the ordinary case — cannot rebuild the addresses without it.
 */
import { Keypair } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { hexToBytes } from "@noble/hashes/utils.js";
import { toSolanaAddress } from "@nihilium/recovery-key-solana";
import { solanaVaultAddresses } from "../settlement/solana/addresses.js";
import { createVaultProgram, keypairFromSecret } from "../settlement/solana/program.js";
import { abortRecovery, type SolanaIntentInputs } from "../settlement/solana/recovery.js";
import { intentDigestFor, readVaultState, relayExecute, relayInitiate } from "../settlement/solana/relay.js";
import { loadFeePayer } from "../settlement/solana/submit.js";
import { executeTransfer } from "../settlement/solana/vault.js";
import { DEFAULT_INTENT_TTL_SECONDS } from "../settlement/evm/intent.js";
import type {
    AbortParams,
    ChainHandover,
    ExecuteParams,
    HandoverProblem,
    InitiateParams,
    InitiateResult,
    SweepParams,
    SweepResult,
} from "./types.js";

export interface SolanaHandoverConfig {
    rpcUrl: string;
    cluster: "devnet";
}

/**
 * Nothing is held back.
 *
 * Unlike the EVM account, which funds its own UserOp out of the balance being moved, the fee here
 * comes from the relayer's fee payer — so the vault's whole balance is sendable and a reserve would
 * be lamports stranded for no reason.
 */
const NO_RESERVE = 0n;

export function createSolanaHandover(config: SolanaHandoverConfig): ChainHandover {
    /**
     * A throwaway keypair, purely to satisfy Anchor's provider.
     *
     * Every instruction this file submits carries its authority in a detached ed25519 signature the
     * program reads out of the `Ed25519SigVerify` instruction, not in the transaction's signers — so
     * nothing here signs as a transaction signer, and the provider's key is never used. Minting one
     * is cheaper and clearer than threading a key that must not matter.
     */
    const unusedSigner = () => Keypair.generate();

    const addressesFor = (creator: string | undefined, accountId: string) => {
        if (creator === undefined) {
            // A PDA cannot be reversed into its seeds. Vaults sealed before this app recorded the creator
            // recover their keys off-chain but give the on-chain handover nothing to act on.
            throw new Error(
                `Vault record has no creator for Solana vault ${accountId}. Re-protect this chain.`,
            );
        }
        return solanaVaultAddresses({ cluster: config.cluster, creator });
    };

    return {
        async preflight({ chainRecord }): Promise<HandoverProblem[]> {
            if (chainRecord.signerAddress === undefined) {
                return [
                    {
                        code: "no-creator",
                        blocking: true,
                        message:
                            "This vault did not record who created the Solana vault account, so its " +
                            "address cannot be rebuilt. Protect this chain again.",
                    },
                ];
            }
            if (chainRecord.recoveryPubKeyHex === undefined) {
                return [
                    {
                        code: "no-recovery-key",
                        blocking: true,
                        message: "This vault recorded no recovery key for this account.",
                    },
                ];
            }
            const ctx = createVaultProgram({
                rpcUrl: config.rpcUrl,
                cluster: config.cluster,
                payer: unusedSigner(),
            });
            const addresses = addressesFor(chainRecord.signerAddress, chainRecord.accountId);

            // No account at all is what "never protected" looks like here: on Solana the protected
            // account has to be created before a key can be registered on it.
            const info = await ctx.connection.getAccountInfo(addresses.vault, "confirmed");
            if (info === null) {
                return [
                    {
                        code: "not-installed",
                        blocking: true,
                        message:
                            "This Solana vault account does not exist, so nothing on-chain would " +
                            "honour a recovery key. Protect the account first — sealing is only the " +
                            "off-chain half.",
                    },
                ];
            }

            const state = await readVaultState(ctx, addresses);
            if (!state.registered) {
                return [
                    {
                        code: "not-installed",
                        blocking: true,
                        message:
                            "No recovery key is registered on this Solana vault. Protect the account " +
                            "first — sealing is only the off-chain half.",
                    },
                ];
            }

            const problems: HandoverProblem[] = [];
            const expected = toSolanaAddress({
                algorithm: "ed25519",
                bytes: hexToBytes(chainRecord.recoveryPubKeyHex.replace(/^0x/, "")),
            });
            if (state.recoveryOwner !== expected) {
                problems.push({
                    code: "owner-mismatch",
                    blocking: true,
                    message:
                        `The chain expects recovery owner ${state.recoveryOwner}, and this vault's key ` +
                        `is ${expected}. The account is protected by a different vault — usually because ` +
                        "the guardians were replaced and the rotation never landed on-chain.",
                });
            }
            const attempt = state.clock.state;
            if (attempt !== null && attempt !== "EXECUTED" && attempt !== "ABORTED") {
                problems.push({
                    code: "attempt-in-flight",
                    blocking: true,
                    message:
                        `A recovery is already ${attempt} on this account. One attempt at a time; ` +
                        "this one must be executed or aborted first.",
                });
            }
            return problems;
        },

        async initiate(params: InitiateParams): Promise<InitiateResult> {
            const ctx = createVaultProgram({
                rpcUrl: config.rpcUrl,
                cluster: config.cluster,
                payer: unusedSigner(),
            });
            const addresses = addressesFor(
                params.chainRecord.signerAddress,
                params.chainRecord.accountId,
            );

            // Read, never remembered: `epoch` and `nonce` are replay protection, and a stale pair
            // produces a signature the program refuses without naming the reason.
            const state = await readVaultState(ctx, addresses);
            params.onProgress?.(`vault      epoch=${state.epoch} nonce=${state.nonce}`);
            if (!state.registered) {
                throw new Error(
                    `No recovery key registered on vault ${addresses.vault.toBase58()}. Protect this chain first.`,
                );
            }

            const intent: SolanaIntentInputs = {
                newOwner: params.newOwner,
                epoch: state.epoch,
                nonce: state.nonce,
                expiry: Math.floor(Date.now() / 1000) + DEFAULT_INTENT_TTL_SECONDS,
            };

            const digest = intentDigestFor(ctx, addresses, intent);
            // ed25519 signs the message, not a pre-hash — the opposite of the EVM adapter, and the
            // reason signing is reached through the chain's own key adapter rather than shared.
            const signature = await params.keyAdapter.sign(params.material, digest);
            params.onProgress?.(`signed     by the recovered key, ${signature.bytes.length} bytes`);

            const result = await relayInitiate(ctx, {
                addresses,
                intent,
                // The public half from the ledger row, not re-derived: it is the key the program
                // compares against, and deriving it here would be a second chance to get it wrong.
                guardianPublicKey: toBase58(requireRecoveryKey(params.chainRecord.recoveryPubKeyHex)),
                signature: signature.bytes,
                serverUrl: params.serverUrl,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
            });
            params.onProgress?.(`initiate   tx=${result.hash}`);
            return { intent, hash: result.hash };
        },

        async execute(params: ExecuteParams): Promise<{ hash: string }> {
            const addresses = addressesFor(
                params.chainRecord.signerAddress,
                params.chainRecord.accountId,
            );
            const result = await relayExecute({
                addresses,
                // Byte-identical to what `initiate` carried, or the program's re-hash misses and
                // the attempt stays open.
                intent: params.intent as SolanaIntentInputs,
                serverUrl: params.serverUrl,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
            });
            params.onProgress?.(`execute    tx=${result.hash} — owner rotated, epoch bumped`);
            return { hash: result.hash };
        },

        async abort(params: AbortParams): Promise<{ hash: string }> {
            // The abort authority signs the transaction itself — `initiate` and `execute` take no
            // signer at all, and that difference is the whole point: those carry their authority in
            // a detached signature anyone may relay, this one is the owner refusing.
            const authority = keypairFromSecret(params.authorityPrivateKeyHex);
            const ctx = createVaultProgram({
                rpcUrl: config.rpcUrl,
                cluster: config.cluster,
                payer: authority,
            });
            const addresses = addressesFor(
                params.chainRecord.signerAddress,
                params.chainRecord.accountId,
            );
            params.onProgress?.(`abort      as ${authority.publicKey.toBase58()}`);
            const hash = await abortRecovery(ctx, {
                addresses,
                abortAuthority: authority,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
            });
            return { hash };
        },

        async sweep(params: SweepParams): Promise<SweepResult> {
            // Signed by the key the recovery rotated the vault to, which the destination seed holds.
            const owner = keypairFromSecret(params.ownerPrivateKeyHex);
            const ctx = createVaultProgram({
                rpcUrl: config.rpcUrl,
                cluster: config.cluster,
                payer: owner,
            });
            const addresses = addressesFor(
                params.chainRecord.signerAddress,
                params.chainRecord.accountId,
            );

            const held = BigInt(await ctx.connection.getBalance(addresses.vaultSol, "confirmed"));
            const moved = params.amount ?? held - NO_RESERVE;
            if (moved <= 0n) {
                throw new Error(
                    `The vault at ${addresses.vaultSol.toBase58()} holds nothing to move.`,
                );
            }

            // The relayer pays. The rotated owner is a fresh key with no SOL, and a sweep that
            // quietly needed it funded would fail in exactly the case this exists for.
            const via = await loadFeePayer(params.serverUrl);
            const hash = await executeTransfer(ctx, {
                addresses,
                to: params.to,
                lamports: moved,
                ...(via ? { via } : {}),
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
            });
            return { hash, moved };
        },
    };
}

function requireRecoveryKey(hex: string | undefined): string {
    if (hex === undefined) {
        // The program compares against exactly that key.
        throw new Error(
            "Vault record has no registered recovery key for this chain.",
        );
    }
    return hex;
}

/** The ledger stores the recovery public key as hex; the program speaks base58. */
function toBase58(hex: string): string {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return base58.encode(bytes);
}
