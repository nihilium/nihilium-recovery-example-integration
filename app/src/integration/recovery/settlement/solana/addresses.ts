/**
 * The two Solana addresses that matter, and the one that cannot be recovered.
 *
 * **A Solana keypair's address *is* its public key.** There is no EIP-7702 analogue, so a lost key
 * means a permanently lost address — recovery cannot be retrofitted onto one. What recovery
 * protects is a **program-owned vault**, created in advance, and only what is inside it. A wallet
 * already holding funds at a plain address has to move them; nothing can rescue the address itself.
 *
 * That makes the Solana wallet a different shape from the EVM one, where the Safe smart account
 * *is* the wallet:
 *
 * | | |
 * |---|---|
 * | **creator / owner** | the derived keypair. Signs, pays, and is **unrecoverable** |
 * | **vault** | the PDA. The protected account, and what goes in `ChainContext.accountId` |
 * | **vaultSol** | the PDA that holds the lamports |
 *
 * **The seeds use `creator`, never `owner`.** A recovery rotates the owner, and an owner in the
 * seeds would move the vault's address on every rotation — orphaning every seal derived against it.
 *
 * **To replace:** nothing; these are the program's own derivations, re-exported so this app has one
 * place that knows them. **Assumes:** the program at `recoveryVaultProgramIds` for the cluster in
 * use. A different deployment is a different vault address for the same inputs.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import {
    recoveryVaultProgramIds,
    vaultAddress,
    vaultSolAddress,
} from "@nihilium/recovery-onchain-solana";

/** The program's `vault_id` seed is 16 bytes. */
const VAULT_ID_BYTES = 16;

export interface SolanaVaultAddresses {
    programId: PublicKey;
    creator: PublicKey;
    /** `ChainContext.accountId` for this chain. Base58. */
    vault: PublicKey;
    /** Where the lamports live. Base58. */
    vaultSol: PublicKey;
}

/**
 * The program's 16-byte vault seed — **a constant, and deliberately not the SDK's `vaultId`.**
 *
 * Two different things share the name `vaultId`, and confusing them moved money. The SDK's is a
 * *gate* label: a fresh one is minted every time you re-seal, because a new ceremony is a new
 * compartment. The program's is a *PDA seed*, and the PDA is the **account** — the Solana answer to
 * a Safe address.
 *
 * Deriving the second from the first meant replacing your guardians created a new vault at a new
 * address and left the funds in the old one. On EVM the same rotation re-installs a module on the
 * same Safe, because a Safe's address has never depended on which gate protects it. This constant
 * is what makes the two chains agree: rotate the gate as often as you like, the account stays put.
 *
 * `creator` is already a seed, so a fixed id still gives every wallet its own vault — one per
 * keypair, exactly as there is one Safe per EOA. A second vault for the same key is not a feature
 * this demo has, and `create_vault` refuses it rather than silently making one.
 */
export function programVaultId(): Uint8Array {
    return sha256(new TextEncoder().encode("nihilium-recovery-demo:vault:v1")).slice(
        0,
        VAULT_ID_BYTES,
    );
}

export function programIdFor(cluster: string): PublicKey {
    const id = recoveryVaultProgramIds[cluster];
    if (id === undefined) {
        // A guessed program id derives a vault address that holds nothing and never will.
        throw new Error(
            `Recovery vault program not deployed on "${cluster}". Known: ` +
                `${Object.keys(recoveryVaultProgramIds).join(", ") || "none"}.`,
        );
    }
    return new PublicKey(id);
}

/**
 * Every address this chain needs, from the creator alone.
 *
 * No `sdkVaultId`: the account is a property of the wallet, not of whichever gate currently guards
 * it. See `programVaultId`.
 */
export function solanaVaultAddresses(params: {
    cluster: string;
    creator: string;
}): SolanaVaultAddresses {
    const programId = programIdFor(params.cluster);
    const creator = new PublicKey(params.creator);
    const [vault] = vaultAddress(programId, creator, programVaultId());
    const [vaultSol] = vaultSolAddress(programId, vault);
    return { programId, creator, vault, vaultSol };
}
