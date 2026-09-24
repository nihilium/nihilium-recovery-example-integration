/**
 * The relayer, on Solana: fees, rent, and nothing else.
 *
 * Same party as the EVM relayer in `index.ts` and the same non-capabilities — it cannot alter an
 * intent (any edit invalidates the guardian's signature), cannot start a recovery of its own, and
 * cannot stop one. Refusing to send is the whole of its power. It lives beside its EVM twin rather
 * than in a role directory of its own because a role is a **party**, not a key, and this party acts
 * on two chains.
 *
 * **Why a relayer is possible here at all.** `initiate_recovery` and `execute_recovery` are
 * permissionless to submit: authority travels in detached ed25519 signatures the program reads out
 * of the `Ed25519SigVerify` instruction, not in the transaction's signers. So a user who has lost
 * access — and therefore has no funded key, by definition — can still have their recovery sent.
 *
 * **Solana needs no paymaster, and `/feepayer` is why.** The fee payer is just a designated signer,
 * so "the server prepays" is a co-sign rather than a contract: the owner signs what they are
 * authorising, this role signs for the cost, and the user needs zero SOL. That also covers **rent**,
 * which has no EVM equivalent — `create_vault` allocates PDAs whose rent-exemption deposit comes
 * from the payer, and the program already declares `payer` separately from `creator` for exactly
 * this.
 *
 * **To replace:** the transport, and `keypairWallet` if your signer is an adapter rather than bytes.
 * **Assumes:** the caller has run its own preflight — this role reports what the chain says and does
 * not decide whether a recovery should be attempted. And that `cluster` matches the tag the deployed
 * program was built with, since that tag is folded into every digest it checks.
 */
import { Router } from "express";
import anchor from "@coral-xyz/anchor";
import type { BN as BNType, Idl, Program as ProgramType } from "@coral-xyz/anchor";
import {
    Connection,
    Ed25519Program,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    ComputeBudgetProgram,
    type VersionedTransaction,
} from "@solana/web3.js";
import {
    digestsFor,
    ed25519MultiSignatureInstruction,
    executeRecoveryArgs,
    initiateRecoveryArgs,
    recoveryVaultIdl,
    type Intent,
    type IntentArg,
    type NihiliumRecoveryVault,
} from "@nihilium/recovery-onchain-solana";

/**
 * Anchor is **CommonJS**, and Node's ESM interop detects only some of its named exports —
 * `AnchorProvider` and `Program` resolve, `BN` does not, and the failure is a `SyntaxError` at
 * import time rather than anything a type checker sees. The app gets away with named imports only
 * because Vite pre-bundles the package; this half runs on native ESM and does not.
 */
const { AnchorProvider, BN, Program } = anchor;

/**
 * Where the ed25519 instruction sits, and therefore the last argument to every program instruction
 * that reads it. Zero because it is the only pre-instruction; the argument and the placement have
 * to agree, and two places holding the same number is how they stop agreeing.
 */
const ED25519_IX_INDEX = 0;

/** The intent, as JSON crosses the wire. `bigint` does not survive `JSON.stringify`. */
export interface SolanaIntentPayload {
    newOwner: string;
    /** Hex, `0x`-optional. Opaque to the program and hashed into the digest. */
    newOwnerConfig?: string;
    epoch: number;
    nonce: number;
    expiry: number;
}

export interface SolanaRelayerDeps {
    connection: Connection;
    /** This role's key. Handed in, so the role never learns where it came from. */
    relayer: Keypair;
    programId: PublicKey;
    /** Bound once. `digestsFor` has no default on purpose — see the header. */
    cluster: Parameters<typeof digestsFor>[0];
    fundMaxLamports: bigint;
    feePayerMaxLamports: bigint;
    /**
     * The operator's veto authorities on this chain, for a wallet to build its own registration.
     *
     * Published rather than applied here, for the same reason the EVM relayer publishes them: they
     * are the *operator's* keys, and only the account can register its own guardian. `abortAuthority`
     * is deliberately absent — it is the wallet's own key, chosen by the wallet.
     *
     * The program refuses a config where one party holds two of these roles
     * (`PauseAndAbortHeldByOneParty` and friends), so these must be genuinely distinct addresses.
     * That check is the chain enforcing what this repo is about; it is not a formality to route
     * around with placeholders.
     */
    vetoConfig: {
        pauseAuthority: string;
        resumeMembers: string[];
        resumeThreshold: number;
        timelockSeconds: number;
        pauseCeilingSeconds: number;
    };
    log?: (message: string) => void;
}

export function createSolanaRelayerRouter(deps: SolanaRelayerDeps): Router {
    const router = Router();
    const note = deps.log ?? (() => undefined);
    const digests = digestsFor(deps.cluster);

    const provider = new AnchorProvider(deps.connection, keypairWallet(deps.relayer), {
        commitment: "confirmed",
    });
    // The IDL carries the address of the build it came from. Checked rather than trusted: a
    // mismatch means this client would talk to a program the digests were never built for.
    if (recoveryVaultIdl.address !== deps.programId.toBase58()) {
        // Otherwise every digest is computed against the wrong program.
        throw new Error(
            `Bundled IDL is for ${recoveryVaultIdl.address}; this server is configured for ` +
                `${deps.programId.toBase58()}. Rebuild so they match.`,
        );
    }
    const program = new Program(recoveryVaultIdl as Idl, provider) as ProgramType<NihiliumRecoveryVault>;

    /**
     * What a client needs to talk to this role, and to know it exists.
     *
     * The cluster is published because a caller signing against a different one produces signatures
     * the program rejects with no reason attached. Better to disagree here than on-chain.
     */
    router.get("/config", (_req, res) => {
        res.json({
            relayer: deps.relayer.publicKey.toBase58(),
            programId: deps.programId.toBase58(),
            cluster: deps.cluster,
            fundMaxLamports: deps.fundMaxLamports.toString(),
            feePayerMaxLamports: deps.feePayerMaxLamports.toString(),
            ...deps.vetoConfig,
        });
    });

    /**
     * Open a recovery on behalf of someone whose key this role does not hold.
     *
     * `ed25519MultiSignatureInstruction` packs a **pre-made** signature, which is the whole trick —
     * `signAll` would need the guardian's secret, and the guardian is not here.
     */
    router.post("/initiate", async (req, res) => {
        const { vault, intent, guardianPublicKey, signature } = req.body as {
            vault?: string;
            intent?: SolanaIntentPayload;
            guardianPublicKey?: string;
            signature?: string;
        };
        if (!vault || !intent || !guardianPublicKey || !signature) {
            res.status(400).json({
                error: "`vault`, `intent`, `guardianPublicKey` and `signature` are all required.",
            });
            return;
        }

        try {
            const vaultKey = new PublicKey(vault);
            const { arg, forDigest } = toIntent(intent);
            // Recomputed here, never taken from the request. A client-supplied message would let a
            // caller pair a signature with a different intent — the program refuses it either way,
            // but after the fee and with an error naming nothing.
            const digest = digests.intentDigest(deps.programId, vaultKey, forDigest);

            const hash = await program.methods
                .initiateRecovery(...initiateRecoveryArgs({ intent: arg, ed25519Index: ED25519_IX_INDEX }))
                .accounts({ vault: vaultKey })
                .preInstructions([
                    ed25519MultiSignatureInstruction([
                        {
                            publicKey: new PublicKey(guardianPublicKey).toBytes(),
                            signature: decodeSignature(signature),
                            message: digest,
                        },
                    ]),
                ])
                .rpc();

            note(`solana initiate ${vault} digest=${digest.toString("hex").slice(0, 16)} tx=${hash}`);
            res.json({ hash, digest: digest.toString("hex") });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    /**
     * Finish it. No signature: the attempt already holds the digest, and the timelock — not a second
     * signature — is what gates this. Exactly as on EVM.
     */
    router.post("/execute", async (req, res) => {
        const { vault, intent } = req.body as { vault?: string; intent?: SolanaIntentPayload };
        if (!vault || !intent) {
            res.status(400).json({ error: "`vault` and `intent` are required." });
            return;
        }
        try {
            const vaultKey = new PublicKey(vault);
            // Byte-identical to the one `initiate` was called with, or the program's re-hash misses.
            const { arg } = toIntent(intent);
            const hash = await program.methods
                .executeRecovery(...executeRecoveryArgs({ intent: arg }))
                .accounts({ vault: vaultKey })
                .rpc();
            note(`solana execute ${vault} tx=${hash} — owner rotated, epoch bumped`);
            res.json({ hash });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    /**
     * A demo faucet, capped. The devnet airdrop is rate-limited and frequently down, and "go and
     * find a working faucet" is where a reader stops reading.
     */
    router.post("/fund", async (req, res) => {
        const { to, lamports } = req.body as { to?: string; lamports?: string };
        if (!to) {
            res.status(400).json({ error: "`to` is required." });
            return;
        }
        const amount = lamports === undefined ? deps.fundMaxLamports : BigInt(lamports);
        if (amount > deps.fundMaxLamports) {
            res.status(400).json({
                error: `Capped at ${lamportsToSol(deps.fundMaxLamports)} SOL per request; asked for ${lamportsToSol(amount)}.`,
            });
            return;
        }
        try {
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: deps.relayer.publicKey,
                    toPubkey: new PublicKey(to),
                    lamports: Number(amount),
                }),
            );
            const hash = await provider.sendAndConfirm(tx, []);
            note(`solana fund ${to} ${amount} lamports tx=${hash}`);
            res.json({ hash, lamports: amount.toString() });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    /**
     * Co-sign a transaction the caller built and pay for it.
     *
     * The caller signs what they are authorising; this role signs only for the cost. **The allowlist
     * below is the feature, not a formality** — without it this route pays for any transaction
     * anyone sends, and the relayer is drained inside a minute.
     */
    router.post("/feepayer", async (req, res) => {
        const { transaction } = req.body as { transaction?: string };
        if (!transaction) {
            res.status(400).json({ error: "`transaction` (base64) is required." });
            return;
        }

        let tx: Transaction;
        try {
            tx = Transaction.from(Buffer.from(transaction, "base64"));
        } catch {
            res.status(400).json({ error: "`transaction` is not a base64 legacy transaction." });
            return;
        }

        const refusal = await refuse(tx);
        if (refusal !== null) {
            // Which rule failed, not "rejected". A 400 that says nothing teaches nothing.
            res.status(400).json({ error: refusal });
            return;
        }

        try {
            tx.partialSign(deps.relayer);
            const hash = await deps.connection.sendRawTransaction(tx.serialize());
            await deps.connection.confirmTransaction(hash, "confirmed");
            note(`solana feepayer tx=${hash} — ${tx.instructions.length} instruction(s), paid by relayer`);
            res.json({ hash });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    /** Every reason this role declines to pay. Returns the message, or `null` to proceed. */
    async function refuse(tx: Transaction): Promise<string | null> {
        if (tx.feePayer === undefined || !tx.feePayer.equals(deps.relayer.publicKey)) {
            return (
                `This transaction's fee payer is ${tx.feePayer?.toBase58() ?? "unset"}, not ` +
                `${deps.relayer.publicKey.toBase58()}. Set the relayer as fee payer before signing, ` +
                "or its signature will not be the one the transaction is missing."
            );
        }

        // Everything except the relayer's own slot must already be signed. Otherwise this role is
        // being asked to pay for a transaction that is still open to change.
        const unsigned = tx.signatures.filter(
            (entry) => entry.signature === null && !entry.publicKey.equals(deps.relayer.publicKey),
        );
        if (unsigned.length > 0) {
            return (
                `${unsigned.length} signature(s) besides the relayer's are still missing (` +
                `${unsigned.map((u) => u.publicKey.toBase58()).join(", ")}). This role pays for a ` +
                "finished transaction; it does not complete one."
            );
        }

        // `create_vault`'s account allocation is a CPI the program makes internally, so a legitimate
        // transaction never calls SystemProgram from the outside. One that does is asking this role
        // to fund a plain transfer.
        const allowed = new Set([
            deps.programId.toBase58(),
            Ed25519Program.programId.toBase58(),
            ComputeBudgetProgram.programId.toBase58(),
        ]);
        const foreign = tx.instructions
            .map((ix) => ix.programId.toBase58())
            .filter((id) => !allowed.has(id));
        if (foreign.length > 0) {
            return (
                `This transaction calls ${[...new Set(foreign)].join(", ")}, and this role pays only ` +
                `for the recovery program (${deps.programId.toBase58()}), the ed25519 precompile and ` +
                "the compute budget. Anything else is a transaction it did not build."
            );
        }

        // A stale blockhash would be rejected by the cluster anyway, but catching it here means the
        // caller learns the cause instead of a generic send failure.
        if (tx.recentBlockhash === undefined) return "This transaction carries no recent blockhash.";
        const valid = await deps.connection.isBlockhashValid(tx.recentBlockhash, {
            commitment: "confirmed",
        });
        if (!valid.value) {
            return "This transaction's blockhash has expired. Rebuild it against a recent one and re-sign.";
        }

        // Rent, not just fees: `create_vault` allocates PDAs and their rent-exemption deposit comes
        // from whoever pays. A ceiling tuned to transaction fees alone would refuse every vault.
        const simulated = await deps.connection.simulateTransaction(tx);
        if (simulated.value.err !== null) {
            // **The logs, not just the code.** A bare `{"InstructionError":[1,{"Custom":6027}]}`
            // is a number that names nothing, and decoding it by hand needs the exact IDL the
            // deployed binary was built from — which is not something a caller has. Anchor already
            // writes the answer into the program logs, so the fix is to stop discarding them.
            const anchor = (simulated.value.logs ?? []).filter((line) =>
                /AnchorError|Error Message|Error Code|Program log: /.test(line),
            );
            const detail =
                anchor.length > 0
                    ? ` ${anchor.slice(-4).join(" | ")}`
                    : " No program logs were returned, which usually means it failed before the " +
                      "program ran — a missing account or a malformed instruction.";
            return `This transaction fails in simulation (${JSON.stringify(simulated.value.err)}).${detail}`;
        }
        const before = BigInt(await deps.connection.getBalance(deps.relayer.publicKey, "confirmed"));
        const after = BigInt(simulated.value.accounts?.[0]?.lamports ?? before);
        const cost = before > after ? before - after : 0n;
        if (cost > deps.feePayerMaxLamports) {
            return (
                `This transaction would cost the relayer ${lamportsToSol(cost)} SOL, over the ` +
                `${lamportsToSol(deps.feePayerMaxLamports)} SOL ceiling.`
            );
        }

        return null;
    }

    return router;
}

/**
 * One intent in the two shapes that must agree.
 *
 * The digest builder takes plain numbers and a `Buffer`; the instruction takes `BN`s and a
 * `Uint8Array`. Building them separately is how a signature ends up covering a different intent
 * than the one submitted.
 */
function toIntent(payload: SolanaIntentPayload): { arg: IntentArg<BNType>; forDigest: Intent } {
    const newOwner = new PublicKey(payload.newOwner);
    const config = payload.newOwnerConfig === undefined ? new Uint8Array() : hexToBytes(payload.newOwnerConfig);
    return {
        arg: {
            newOwner,
            // `Buffer`, not `Uint8Array`. Anchor encodes `bytes` through buffer-layout's `Blob`,
            // which type-checks its source and refuses anything else — and refuses it with
            // "Blob.encode[data] requires (length 0) Buffer as src", which names the length rather
            // than the type and so reads as "the value is empty" when the value is the wrong class.
            // Empty is fine here: an EVM intent carries validator init data, a Solana one carries
            // nothing, and the field exists so both chains share one digest shape.
            newOwnerConfig: Buffer.from(config),
            epoch: new BN(payload.epoch),
            nonce: new BN(payload.nonce),
            expiry: new BN(payload.expiry),
        },
        forDigest: {
            newOwner,
            newOwnerConfig: Buffer.from(config),
            epoch: payload.epoch,
            nonce: payload.nonce,
            expiry: payload.expiry,
        },
    };
}

/** Base64 or hex, because a browser and a curl script reach for different ones. */
function decodeSignature(value: string): Uint8Array {
    const bytes = /^(0x)?[0-9a-fA-F]{128}$/.test(value)
        ? hexToBytes(value)
        : new Uint8Array(Buffer.from(value, "base64"));
    if (bytes.length !== 64) {
        throw new Error(`An ed25519 signature is 64 bytes; got ${bytes.length}.`);
    }
    return bytes;
}

function hexToBytes(value: string): Uint8Array {
    const bare = value.startsWith("0x") ? value.slice(2) : value;
    const out = new Uint8Array(bare.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function lamportsToSol(lamports: bigint): string {
    return (Number(lamports) / 1e9).toFixed(4);
}

/**
 * Anchor wants a `Wallet`. A real integration passes its adapter here instead and deletes this.
 */
function keypairWallet(payer: Keypair) {
    return {
        publicKey: payer.publicKey,
        async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
            if ("partialSign" in tx) tx.partialSign(payer);
            else tx.sign([payer]);
            return tx;
        },
        async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
            for (const tx of txs) {
                if ("partialSign" in tx) tx.partialSign(payer);
                else tx.sign([payer]);
            }
            return txs;
        },
        payer,
    };
}

/**
 * The closest thing to a reason — and on this chain that means **the program's logs**.
 *
 * A Solana failure reaches a caller as `{"InstructionError":[1,{"Custom":6007}]}`: an index and a
 * number. Decoding the number needs the exact IDL the deployed binary was built from, which is not
 * something a caller has and not something this repo can promise — a checkout can be ahead of a
 * deployment, and then the number names the wrong error confidently. Anchor writes the real message
 * into the logs, so those are what get returned.
 */
function reasonOf(error: unknown): string {
    const logs =
        typeof error === "object" && error !== null && "logs" in error && Array.isArray(error.logs)
            ? (error.logs as string[]).filter((line) => /AnchorError|Error Message|Instruction: /.test(line))
            : [];
    const base =
        typeof error === "object" && error !== null && "shortMessage" in error
            ? String((error as { shortMessage: unknown }).shortMessage)
            : error instanceof Error
              ? error.message
              : String(error);
    return logs.length > 0 ? `${base} — ${logs.slice(-3).join(" | ")}` : base;
}
