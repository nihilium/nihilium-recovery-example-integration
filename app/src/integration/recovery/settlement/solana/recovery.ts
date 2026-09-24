/**
 * The recovery itself: open it, veto it, finish it.
 *
 * **Three of these five take no signer at all.** `initiate_recovery`, `resume` and
 * `execute_recovery` are permissionless to submit — their authority is carried in detached
 * signatures the program reads out of the `Ed25519SigVerify` instruction, not in the transaction's
 * signers. That is what lets a relayer broadcast for somebody with no funded account, and lets an
 * intent be signed once offline and submitted much later. `pause` and `abort` are the exceptions:
 * those authorities sign the transaction directly.
 *
 * `execute_recovery` rotates `owner` and bumps `epoch`. It moves no lamports and makes no CPI, so a
 * guardian key extracted from a spent vault yields the committed rotation and never the funds.
 *
 * **To replace:** nothing. **Assumes:** the intent handed to `executeRecovery` is byte-identical to
 * the one the attempt was opened with — the program re-hashes it and compares, and never re-checks
 * the signature.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey, type Keypair } from "@solana/web3.js";
import {
    executeRecoveryArgs,
    initiateRecoveryArgs,
    VetoStateOrdinal,
    type Intent,
    type IntentArg,
} from "@nihilium/recovery-onchain-solana";
import type { SolanaVaultAddresses } from "./addresses.js";
import { detachedSignatures, ED25519_IX_INDEX } from "./signing.js";
import type { VaultProgram } from "./program.js";

export interface SolanaIntentInputs {
    /** Where control lands. Not the guardian — that key signs the handover, it does not receive it. */
    newOwner: string;
    /** Opaque to the program, hashed into the digest. Empty where the chain needs no owner config. */
    newOwnerConfig?: Uint8Array;
    epoch: number;
    nonce: number;
    /** Unix seconds. Must outlast the timelock or the attempt can never mature. */
    expiry: number;
}

/**
 * One intent in the two shapes that must agree.
 *
 * The digest builder takes plain numbers and a `Buffer`; the instruction takes `BN`s and a
 * `Uint8Array`. They describe the same intent and are built here from one set of inputs, because
 * building them separately is how a signature ends up covering a different intent than the one
 * submitted — which fails at `initiate_recovery` as a bad signature, pointing nowhere near the
 * cause.
 */
export function toIntent(inputs: SolanaIntentInputs): { arg: IntentArg<BN>; forDigest: Intent } {
    const newOwner = new PublicKey(inputs.newOwner);
    const config = inputs.newOwnerConfig ?? new Uint8Array();
    return {
        arg: {
            newOwner,
            newOwnerConfig: config,
            epoch: new BN(inputs.epoch),
            nonce: new BN(inputs.nonce),
            expiry: new BN(inputs.expiry),
        },
        forDigest: {
            newOwner,
            newOwnerConfig: Buffer.from(config),
            epoch: inputs.epoch,
            nonce: inputs.nonce,
            expiry: inputs.expiry,
        },
    };
}

/** Open a recovery. Permissionless to send; the guardian's detached signature is the authority. */
export async function initiateRecovery(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        intent: SolanaIntentInputs;
        /** Signs the intent digest. In a real recovery this is the key `recover()` handed back. */
        guardian: Keypair;
        onProgress?: (m: string) => void;
    },
): Promise<{ signature: string; intent: IntentArg<BN>; digest: Buffer }> {
    const { arg: intent, forDigest } = toIntent(params.intent);
    const digest = ctx.digests.intentDigest(ctx.programId, params.addresses.vault, forDigest);
    params.onProgress?.(`initiate      digest=${digest.toString("hex").slice(0, 16)}…`);

    const signature = await ctx.program.methods
        .initiateRecovery(...initiateRecoveryArgs({ intent, ed25519Index: ED25519_IX_INDEX }))
        .accounts({ vault: params.addresses.vault })
        .preInstructions([detachedSignatures([params.guardian], digest)])
        .rpc();

    params.onProgress?.(`initiate      tx=${signature}`);
    // The intent is returned because `execute_recovery` needs it byte-identical: the program
    // re-hashes what it is given and compares, and never re-checks the signature.
    return { signature, intent, digest };
}

/** Stop the clock. Only from INITIATED, and only the pause authority may. */
export async function pauseRecovery(
    ctx: VaultProgram,
    params: { addresses: SolanaVaultAddresses; pauseAuthority: Keypair; onProgress?: (m: string) => void },
): Promise<string> {
    const signature = await ctx.program.methods
        .pause()
        .accounts({
            vault: params.addresses.vault,
            pauseAuthority: params.pauseAuthority.publicKey,
        })
        .signers([params.pauseAuthority])
        .rpc();
    params.onProgress?.(`pause         tx=${signature} — the clock is stopped, not the recovery`);
    return signature;
}

/**
 * Restart the clock early, on k distinct members' detached signatures.
 *
 * A pause also lifts by itself at the ceiling with no signature and no transaction, so this is the
 * shortcut rather than the only exit. The stored account keeps reading `PAUSED` until someone
 * writes to it — project the clock client-side before showing a user anything.
 */
export async function resumeRecovery(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        intentDigest: Buffer;
        attemptSeq: number;
        /** Exactly the threshold, and distinct. The program counts them. */
        members: readonly Keypair[];
        onProgress?: (m: string) => void;
    },
): Promise<string> {
    const digest = ctx.digests.resumeDigest(
        ctx.programId,
        params.addresses.vault,
        params.intentDigest,
        params.attemptSeq,
    );

    const signature = await ctx.program.methods
        .resume(
            params.members.map((m) => m.publicKey),
            ED25519_IX_INDEX,
        )
        .accounts({ vault: params.addresses.vault })
        // One instruction carrying k signatures, not k instructions: the program checks the count.
        .preInstructions([detachedSignatures(params.members, digest)])
        .rpc();

    params.onProgress?.(`resume        tx=${signature} by ${params.members.length} members`);
    return signature;
}

/** Terminal, irreversible, and the owner's own key by default in this demo. */
export async function abortRecovery(
    ctx: VaultProgram,
    params: { addresses: SolanaVaultAddresses; abortAuthority: Keypair; onProgress?: (m: string) => void },
): Promise<string> {
    const signature = await ctx.program.methods
        .abort()
        .accounts({
            vault: params.addresses.vault,
            abortAuthority: params.abortAuthority.publicKey,
        })
        .signers([params.abortAuthority])
        .rpc();
    params.onProgress?.(`abort         tx=${signature} — terminal`);
    return signature;
}

/** Finish it. Permissionless, and the only thing that moves control. */
export async function executeRecovery(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        /** Byte-identical to the one `initiate` was called with. */
        intent: IntentArg<BN>;
        onProgress?: (m: string) => void;
    },
): Promise<string> {
    const signature = await ctx.program.methods
        .executeRecovery(...executeRecoveryArgs({ intent: params.intent }))
        .accounts({ vault: params.addresses.vault })
        .rpc();
    params.onProgress?.(`execute       tx=${signature} — owner rotated, epoch bumped`);
    return signature;
}

/**
 * The vault's state with the veto clock projected forward.
 *
 * Simulated rather than sent: a pause past its ceiling has auto-resumed in every sense that matters,
 * but the stored account still says `PAUSED` until somebody writes to it. Reading the raw field
 * would show a freeze that is already over.
 */
export async function projectedState(
    ctx: VaultProgram,
    addresses: SolanaVaultAddresses,
): Promise<keyof typeof VetoStateOrdinal> {
    const ordinal = await ctx.program.methods
        .projectedState()
        .accounts({ vault: addresses.vault })
        .view();

    const name = (Object.keys(VetoStateOrdinal) as (keyof typeof VetoStateOrdinal)[]).find(
        (key) => VetoStateOrdinal[key] === Number(ordinal),
    );
    if (name === undefined) {
        // Treated as unsafe rather than mapped to the nearest known state.
        throw new Error(
            `Unknown veto state ${String(ordinal)}: this build does not know it.`,
        );
    }
    return name;
}
