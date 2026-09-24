/**
 * The Anchor client for the recovery vault program, built one way in one place.
 *
 * Every instruction goes through here so the program id, the IDL and the cluster can never disagree
 * — three values that are individually plausible and jointly meaningless when mismatched. A client
 * pointed at the right program with the wrong cluster produces signatures the program rejects
 * without saying why.
 *
 * **Arguments go through `registerArgs` / `initiateRecoveryArgs` / `executeRecoveryArgs`, never
 * positionally.** Anchor's generated type checks arity and types only for instructions whose
 * arguments are primitives; a `defined` struct collapses the whole tuple to `any`, so exactly the
 * three instructions that matter get no checking at all — `register(owner)` with one of four
 * arguments compiles, and so does a transposed `u64`/`u8` pair. Named arguments make both
 * impossible.
 *
 * **To replace:** the wallet. This demo signs with a keypair it derived; a real app hands Anchor a
 * wallet adapter and never sees the secret.
 * **Assumes:** the program at `recoveryVaultProgramIds[cluster]` was built for that same cluster.
 * A localnet binary deployed to devnet produces digests nobody can match — check with
 * `strings <program>.so | grep nihilium-cluster:`.
 */
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
    Connection,
    Keypair,
    PublicKey,
    type Transaction,
    type VersionedTransaction,
} from "@solana/web3.js";
import {
    recoveryVaultIdl,
    type NihiliumRecoveryVault,
} from "@nihilium/recovery-onchain-solana";
import { programIdFor } from "./addresses.js";
import { solanaDigests, type ClusterName } from "./digests.js";

export interface VaultProgram {
    program: Program<NihiliumRecoveryVault>;
    connection: Connection;
    programId: PublicKey;
    payer: Keypair;
    digests: ReturnType<typeof solanaDigests>;
}

/**
 * A wallet that signs with one keypair.
 *
 * Anchor wants a `Wallet`, and the browser-adapter shape is more machinery than a demo holding a
 * derived key needs. A real integration passes its adapter here instead and deletes this.
 */
function keypairWallet(payer: Keypair) {
    return {
        publicKey: payer.publicKey,
        async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
            if ("partialSign" in tx) tx.partialSign(payer);
            else tx.sign([payer]);
            return tx;
        },
        async signAllTransactions<T extends Transaction | VersionedTransaction>(
            txs: T[],
        ): Promise<T[]> {
            for (const tx of txs) {
                if ("partialSign" in tx) tx.partialSign(payer);
                else tx.sign([payer]);
            }
            return txs;
        },
        payer,
    };
}

export function createVaultProgram(params: {
    rpcUrl: string;
    cluster: ClusterName;
    /** The owner/creator. Signs `create_vault`, `register` and `execute_transfer`. */
    payer: Keypair;
}): VaultProgram {
    const connection = new Connection(params.rpcUrl, "confirmed");
    const programId = programIdFor(params.cluster);

    const provider = new AnchorProvider(connection, keypairWallet(params.payer), {
        commitment: "confirmed",
    });

    // The IDL carries its own `address`, which is the build it came from. Checked against the
    // address book rather than trusted: a mismatch means this client would talk to a program the
    // digests were never built for.
    if (recoveryVaultIdl.address !== programId.toBase58()) {
        // Otherwise every digest is computed against the wrong program.
        throw new Error(
            `Bundled IDL is for ${recoveryVaultIdl.address}; ${params.cluster} resolves to ` +
                `${programId.toBase58()}. Rebuild so they match.`,
        );
    }

    return {
        program: new Program(recoveryVaultIdl as Idl, provider) as Program<NihiliumRecoveryVault>,
        connection,
        programId,
        payer: params.payer,
        digests: solanaDigests(params.cluster),
    };
}

/** The demo's owner keypair, from the seed the wallet already derived. */
export function keypairFromSecret(secretHex: string): Keypair {
    const hex = secretHex.startsWith("0x") ? secretHex.slice(2) : secretHex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    // ed25519 secret keys are 32 bytes of seed; `fromSeed` derives the 64-byte expanded form.
    return Keypair.fromSeed(bytes.slice(0, 32));
}
