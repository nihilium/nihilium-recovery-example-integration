/**
 * Detached ed25519 signatures, packed the one way the program accepts.
 *
 * Authority for `register`, `initiate_recovery` and `resume` comes from signatures carried in the
 * transaction's `Ed25519SigVerify` instruction, **not from its signers**. That is what lets a
 * relayer broadcast for a user with no funded account, and lets an intent be signed once offline
 * and submitted later.
 *
 * **Always `signAll`, never hand-rolled offsets.** The precompile verifies whatever it is asked to
 * verify, and reads the signed message from whichever instruction the offsets name. Point those at
 * two different places and the precompile and an introspecting program disagree about what was
 * signed — at which point any signature the guardian ever published authorises any recovery. The
 * program closes this by requiring every offset to reference the instruction under inspection, and
 * refuses anything else with `ForeignInstructionReference`. `signAll` sets all indices to "this
 * instruction", which is the only shape that passes.
 *
 * `@solana/web3.js` cannot help here: it only produces single-signature instructions, and a k-of-n
 * resume needs **one** instruction carrying k signatures, because the program checks the count
 * exactly.
 *
 * **To replace:** nothing. **Assumes:** the ed25519 instruction is placed where `ED25519_IX_INDEX`
 * says, because every instruction takes that index as its last argument and reads the wrong
 * instruction if it is wrong.
 */
import type { Keypair, TransactionInstruction } from "@solana/web3.js";
import { ed25519MultiSignatureInstruction, signAll } from "@nihilium/recovery-onchain-solana";
import { MAX_RESUME_MEMBERS } from "@nihilium/recovery-onchain-solana";

/**
 * Where the ed25519 instruction goes, and therefore the last argument to every program instruction
 * that reads it.
 *
 * Zero because it is added with `preInstructions` and is the only one. Kept as a named constant
 * rather than a literal at each call site: the argument and the placement have to agree, and two
 * places holding the same number is how they stop agreeing.
 */
export const ED25519_IX_INDEX = 0;

/** One instruction carrying every signature. See the header for why not one per signer. */
export function detachedSignatures(
    signers: readonly Keypair[],
    digest: Buffer,
): TransactionInstruction {
    if (signers.length === 0) {
        throw new Error("An ed25519 instruction with no signatures authorises nothing.");
    }
    if (signers.length > MAX_RESUME_MEMBERS) {
        // k signatures must fit Solana's 1232-byte transaction at ~110 bytes each; a larger quorum
        // is a pause that could never be lifted.
        throw new Error(
            `${signers.length} signatures exceed the program's cap of ${MAX_RESUME_MEMBERS}.`,
        );
    }
    return signAll([...signers], digest);
}

/**
 * The same instruction, from a signature somebody else made.
 *
 * `signAll` needs the secret, and the party that must sign a registration is the **recovery key** —
 * which the app holds only for the instant it takes to make this one signature. Splitting the
 * signing from the packing is what lets that key be derived, used and wiped without ever reaching
 * this file.
 */
export function detachedSignature(
    publicKey: Uint8Array,
    signature: Uint8Array,
    digest: Buffer,
): TransactionInstruction {
    if (signature.length !== 64) {
        throw new Error(`An ed25519 signature is 64 bytes; got ${signature.length}.`);
    }
    return ed25519MultiSignatureInstruction([{ publicKey, signature, message: digest }]);
}

export { MAX_RESUME_MEMBERS };
