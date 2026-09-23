/**
 * Creating a vault, registering a guardian against it, and moving value out of it.
 *
 * These are the three things the **owner** does. The owner signs the transaction for each; the
 * guardian's authority arrives separately, as a detached signature the program reads out of the
 * `Ed25519SigVerify` instruction rather than out of the transaction's signers.
 *
 * `execute_transfer` is the only instruction in the whole program that moves lamports. Everything
 * else changes who is allowed to — which is why extracting the guardian key yields a committed
 * rotation and never the funds.
 *
 * **To replace:** nothing, for this program. **Assumes:** `create_vault` has run before anything
 * else here, because the vault PDA is `ChainContext.accountId` and a seal bound to an address that
 * does not exist is a seal bound to nothing.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
    registerArgs,
    vetoFingerprint,
    type VetoConfigArg,
} from "@nihilium/recovery-onchain-solana";
import { programVaultId, type SolanaVaultAddresses } from "./addresses.js";
import { detachedSignature, ED25519_IX_INDEX, MAX_RESUME_MEMBERS } from "./signing.js";
import { submit, type Submitter } from "./submit.js";
import type { VaultProgram } from "./program.js";

export interface SolanaVetoInputs {
    pauseAuthority: string;
    abortAuthority: string;
    resumeMembers: readonly string[];
    resumeThreshold: number;
    timelockSeconds: number;
    pauseCeilingSeconds: number;
}

/**
 * The program's own veto rules, checked before a transaction is built.
 *
 * Every one of these is enforced on-chain and would otherwise arrive as
 * `{"InstructionError":[1,{"Custom":6027}]}` — a number, from a simulation, naming nothing. The
 * cost of re-stating them here is that they can drift; the cost of not is that the demo's most
 * important lesson reads as a malfunction.
 *
 * **The disjointness rules are the lesson, not a formality.** Three veto roles on one key looks
 * correctly configured and is worth nothing, so the program refuses it outright rather than
 * trusting the operator to have meant it.
 */
export function assertSolanaVetoUsable(veto: SolanaVetoInputs): void {
    const fail = (code: number, name: string, why: string): never => {
        throw new Error(`${name} (the program would reject this as Custom(${code})): ${why}`);
    };

    if (veto.resumeMembers.length === 0) {
        fail(6022, "ResumeQuorumIsEmpty", "a pause with no quorum could never be lifted early.");
    }
    if (veto.resumeThreshold === 0) {
        fail(6023, "ResumeThresholdIsZero", "a zero threshold is a quorum anyone can satisfy.");
    }
    if (veto.resumeThreshold > veto.resumeMembers.length) {
        fail(
            6024,
            "ResumeThresholdExceedsMembership",
            `${veto.resumeThreshold} of ${veto.resumeMembers.length} can never be reached.`,
        );
    }
    if (veto.timelockSeconds === 0) fail(6025, "TimelockIsZero", "a recovery would execute instantly.");
    if (veto.pauseCeilingSeconds === 0) {
        fail(6026, "PauseCeilingIsZero", "a pause would never auto-resume, so it would be an abort.");
    }
    if (veto.pauseAuthority === veto.abortAuthority) {
        fail(
            6027,
            "PauseAndAbortHeldByOneParty",
            "one key that can both stall and kill a recovery is one party, not two.",
        );
    }
    if (veto.resumeMembers.includes(veto.pauseAuthority)) {
        fail(6028, "PauseAndResumeHeldByOneParty", "the pauser must not sit in the quorum that lifts it.");
    }
    if (veto.resumeMembers.includes(veto.abortAuthority)) {
        fail(6029, "ResumeAndAbortHeldByOneParty", "the aborter must not sit in the resume quorum.");
    }
    if (veto.resumeMembers.some((m) => m === ZERO_ADDRESS)) {
        fail(6030, "ResumeQuorumContainsZeroAddress", "a member nobody holds is a member who never signs.");
    }
    if (new Set(veto.resumeMembers).size !== veto.resumeMembers.length) {
        fail(6031, "ResumeQuorumContainsDuplicate", "a duplicate counts one party twice toward the threshold.");
    }
    if (veto.resumeMembers.length > MAX_RESUME_MEMBERS) {
        fail(
            6032,
            "TooManyResumeMembers",
            `${veto.resumeMembers.length} signatures do not fit one transaction; the cap is ${MAX_RESUME_MEMBERS}.`,
        );
    }
}

/** Solana's all-zero address, which base58-encodes to this. */
const ZERO_ADDRESS = "11111111111111111111111111111111";

export function toVetoArg(inputs: SolanaVetoInputs): VetoConfigArg<BN> {
    // Checked here rather than at the call site: this is the one funnel every registration goes
    // through, and a guard a caller can forget is a guard that does not exist.
    assertSolanaVetoUsable(inputs);
    return {
        pauseAuthority: new PublicKey(inputs.pauseAuthority),
        abortAuthority: new PublicKey(inputs.abortAuthority),
        resumeMembers: inputs.resumeMembers.map((m) => new PublicKey(m)),
        resumeThreshold: inputs.resumeThreshold,
        timelockSeconds: new BN(inputs.timelockSeconds),
        pauseCeilingSeconds: new BN(inputs.pauseCeilingSeconds),
    };
}

/**
 * An empty vault, owned by its creator.
 *
 * The creator becomes the first owner, and the seeds use the **creator** — so a later rotation
 * moves the owner without moving the address, and every seal derived against it stays valid.
 */
export async function createVault(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        /** Who pays the fee and the PDAs' rent. Defaults to the creator. See `submit.ts`. */
        via?: Submitter;
        onProgress?: (m: string) => void;
    },
): Promise<string> {
    const vaultId = Buffer.from(programVaultId());
    params.onProgress?.(`create_vault  ${params.addresses.vault.toBase58()}`);

    const builder = ctx.program.methods
        .createVault([...vaultId])
        // `vault`, `vault_sol` and `system_program` are resolved by Anchor from the IDL's own seeds
        // and fixed address. Passing them is not redundancy, it is a second derivation that can
        // disagree with the program's.
        .accounts({
            // Separate accounts on purpose, and the reason a fee payer works at all: the creator is
            // who the vault belongs to, the payer is only who funded its rent. They are the same
            // keypair when nobody else is paying.
            payer: payerOf(ctx, params.via),
            creator: ctx.payer.publicKey,
        });

    const signature = await submit({
        connection: ctx.connection,
        owner: ctx.payer,
        builder,
        via: params.via ?? { kind: "self" },
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });

    params.onProgress?.(`create_vault  tx=${signature}`);
    return signature;
}

/**
 * Who the instruction should name as payer.
 *
 * Resolved synchronously from the cached relayer address, because `create_vault` takes it as an
 * account rather than inferring it from the fee payer — an account list that disagreed with the
 * transaction's fee payer would fail inside the program, not at the signature.
 */
function payerOf(ctx: VaultProgram, via: Submitter | undefined): PublicKey {
    return via?.kind === "feePayer" ? new PublicKey(via.relayer) : ctx.payer.publicKey;
}

/**
 * Bind a guardian to the vault — the first registration and every rotation.
 *
 * Two authorities, and they arrive by different routes. The **owner** signs the transaction. The
 * **incoming guardian** signs the registration digest detached, which is what stops a veto key
 * installing a guardian it controls and recovering to itself.
 *
 * `configNonce` must match the vault's current value: it is what makes a registration signature
 * spendable once, so an old one cannot be replayed to revert a rotation.
 */
/**
 * What the incoming guardian has to sign, and the reason registration cannot be pre-signed.
 *
 * It binds the veto **fingerprint** and `config_nonce` as well as the key, so it cannot be computed
 * until both are known: the veto authorities come from the operator and the nonce from the chain.
 * That is why sealing and registering are one operation on this chain — the recovery key exists
 * only while its root is in hand, and the digest it must sign is not knowable until register time.
 *
 * Without the fingerprint, the recovery owner would be signing "I accept being this vault's
 * recovery key" while the parties who can pause, resume and abort their recovery were chosen
 * entirely by whoever submitted the transaction.
 */
export function registrationDigestFor(
    ctx: VaultProgram,
    addresses: SolanaVaultAddresses,
    params: { recoveryOwner: string; veto: SolanaVetoInputs; configNonce: number },
): Buffer {
    return ctx.digests.registrationDigest(
        ctx.programId,
        addresses.vault,
        ctx.payer.publicKey,
        new PublicKey(params.recoveryOwner),
        vetoFingerprint(toVetoArg(params.veto)),
        params.configNonce,
    );
}

export async function registerGuardian(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        /** The recovery key from `addChain()`, base58. */
        recoveryOwner: string;
        veto: SolanaVetoInputs;
        configNonce: number;
        /**
         * The incoming guardian's signature over `registrationDigestFor(...)`, 64 bytes.
         *
         * A signature rather than a key, because the signer is the **recovery key**: it is derived
         * from a root the caller holds for one instant and wipes. Taking a `Keypair` here would
         * mean that root living as long as this call's arguments do.
         */
        guardianSignature: Uint8Array;
        /** Who pays the fee. The owner still signs the transaction either way. */
        via?: Submitter;
        onProgress?: (m: string) => void;
    },
): Promise<string> {
    const veto = toVetoArg(params.veto);
    const recoveryOwner = new PublicKey(params.recoveryOwner);

    // Read, never guessed: the digest binds the program, the vault, the owner, the guardian, the
    // veto fingerprint and the nonce — plus the cluster tag baked into this build.
    const digest = registrationDigestFor(ctx, params.addresses, {
        recoveryOwner: params.recoveryOwner,
        veto: params.veto,
        configNonce: params.configNonce,
    });
    params.onProgress?.(`register      digest=${digest.toString("hex").slice(0, 16)}…`);

    const builder = ctx.program.methods
        // Named, never positional: `veto` is a `defined` struct, which collapses Anchor's whole
        // argument tuple to `any` — arity included.
        .register(
            ...registerArgs({
                recoveryOwner,
                veto,
                configNonce: new BN(params.configNonce),
                ed25519Index: ED25519_IX_INDEX,
            }),
        )
        .accounts({
            vault: params.addresses.vault,
            owner: ctx.payer.publicKey,
        })
        .preInstructions([
            detachedSignature(recoveryOwner.toBytes(), params.guardianSignature, digest),
        ]);

    const signature = await submit({
        connection: ctx.connection,
        owner: ctx.payer,
        builder,
        via: params.via ?? { kind: "self" },
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });

    params.onProgress?.(`register      tx=${signature}`);
    return signature;
}

/** The only instruction that moves lamports. The owner signs it; no guardian is involved. */
export async function executeTransfer(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        to: string;
        lamports: bigint;
        /** Who pays the fee. The owner still signs — it is the owner's money either way. */
        via?: Submitter;
        onProgress?: (m: string) => void;
    },
): Promise<string> {
    params.onProgress?.(`execute_transfer ${params.lamports} lamports to ${params.to}`);

    const builder = ctx.program.methods
        .executeTransfer(new BN(params.lamports.toString()))
        .accounts({
            vault: params.addresses.vault,
            owner: ctx.payer.publicKey,
            destination: new PublicKey(params.to),
        });

    const signature = await submit({
        connection: ctx.connection,
        owner: ctx.payer,
        builder,
        via: params.via ?? { kind: "self" },
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });

    params.onProgress?.(`execute_transfer tx=${signature}`);
    return signature;
}
