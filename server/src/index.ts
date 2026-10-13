/**
 * The demo's server: every role that cannot run in a browser.
 *
 * Three services, each the SDK's own, behind Express: the **record host** (ciphertext and chain
 * context, never a seal), the **watchtower** (watches, never keys) and the **relayer** (gas, and the
 * operator's veto keys). This file is the only one that reads `config` — everything else is handed
 * what it needs, which is what keeps the roles liftable into another codebase.
 *
 * The relayer is one `RelayerService` for all three chains, keyed by CAIP-2 namespace. Each chain
 * gets the SDK's settlement adapter built with a **direct** submitter: every relayed body goes
 * through `prepareRelay`, which rebuilds the transaction from the wire fields rather than trusting
 * a client's bytes.
 */
import cors from "cors";
import express from "express";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arbitrumSepolia, sepolia } from "viem/chains";
import { eip7702AccountAddress, recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { recoveryVaultProgramIds } from "@nihilium/recovery-onchain-solana";
import { hashCredential, type QuorumSigner, type WatchProbe } from "@nihilium/recovery-core";
import { RelayerService, type RelayerChain } from "@nihilium/recovery-relayer";
import {
    Eip7702RecoveryAccountSettlement,
    Erc7579RecoveryModuleSettlement,
    eoaExecutor,
    evmDirectSubmitter,
} from "@nihilium/recovery-settlement-evm";
import { SolanaRecoveryVaultSettlement, solanaDirectSubmitter, solanaOwnerExecutor } from "@nihilium/recovery-settlement-solana";
import { LocalSealedDataStore, LocalWatchStore } from "@nihilium/recovery-storage-local";
import { EvmRecoveryProbe } from "@nihilium/recovery-watchtower-evm";
import { NihiliumRevealProbe } from "@nihilium/recovery-watchtower-nihilium";
import { SolanaRecoveryProbe } from "@nihilium/recovery-watchtower-solana";
import { printBootBanner } from "./boot.js";
import { config } from "./config.js";
import { logError, logInfo } from "./log.js";
import { createRecordsRouter } from "./roles/records/index.js";
import { asSdkPublicClient, asSdkWalletClient } from "./sdkClients.js";
import { createWatchtower } from "./roles/watchtower/index.js";

// From the SDK's address book, never a literal: a redeploy moves these addresses.
const MODULE_ADDRESS = recoveryModuleAddress(config.chainId);

/**
 * The app's vault PDA seed, byte for byte. The SDK's default is a different constant; this demo's
 * vaults were created under this one and the server must derive the same addresses.
 */
const DEMO_VAULT_SEED = sha256(new TextEncoder().encode("nihilium-recovery-demo:vault:v1")).slice(0, 16);

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => logInfo("http", `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`));
    next();
});

app.get("/health", (_req, res) => {
    res.json({ ok: true, chainId: config.chainId, module: MODULE_ADDRESS });
});

// --- The relayer: one service, three chains -----------------------------------------------------

/** One EVM chain's roles, each key bound at construction and never re-pointed. */
function evmChain(params: {
    namespace: string;
    chain: typeof sepolia | typeof arbitrumSepolia;
    rpcUrl: string;
    build: (client: ReturnType<typeof asSdkPublicClient>, submitter: ReturnType<typeof evmDirectSubmitter>) => RelayerChain["adapter"];
    extra: Record<string, unknown>;
}): RelayerChain {
    const client = createPublicClient({ chain: params.chain, transport: http(params.rpcUrl) }) as PublicClient;
    const walletFor = (privateKey: string) => {
        const account = privateKeyToAccount(privateKey as Hex);
        return { account, client: createWalletClient({ account, chain: params.chain, transport: http(params.rpcUrl) }) };
    };
    const relayer = walletFor(config.roles.relayer.on(params.namespace).privateKey);
    const pause = walletFor(config.roles.pause.on(params.namespace).privateKey);
    const resume = config.roles.resume.map((role) => privateKeyToAccount(role.on(params.namespace).privateKey as Hex));
    const direct = evmDirectSubmitter({ walletClient: asSdkWalletClient(relayer.client), publicClient: asSdkPublicClient(client) });

    // Exactly the threshold, not everyone: the contract counts distinct signers. EIP-191 over the
    // digest, which is what both constructions' `resume` verifies.
    const quorum: QuorumSigner = {
        members: resume.map((account) => ({ namespace: params.namespace, id: account.address })),
        threshold: config.resumeThreshold,
        async sign(digest) {
            return Promise.all(resume.slice(0, config.resumeThreshold).map(async (account: PrivateKeyAccount) => ({
                authority: { namespace: params.namespace, id: account.address },
                signature: hexToBytes(await account.signMessage({ message: { raw: toHex(digest) } })),
            })));
        },
    };

    return {
        adapter: params.build(asSdkPublicClient(client), direct),
        direct,
        publish: {
            relayer: relayer.account.address,
            pauseAuthority: pause.account.address,
            resumeMembers: resume.map((account) => account.address),
            resumeThreshold: config.resumeThreshold,
            timelockSeconds: config.timelockSeconds,
            pauseCeilingSeconds: config.pauseCeilingSeconds,
            extra: params.extra,
        },
        // A demo faucet, capped: an account with no ETH cannot install its own module, and "go and
        // find a faucet" is where a reader stops reading.
        fund: {
            max: config.fundMaxWei,
            async send(to, amount) {
                const hash = await relayer.client.sendTransaction({ account: relayer.account, chain: params.chain, to: to as Address, value: amount });
                await client.waitForTransactionReceipt({ hash });
                return { hash };
            },
        },
        operators: { pause: eoaExecutor({ walletClient: asSdkWalletClient(pause.client), publicClient: asSdkPublicClient(client) }), resume: quorum },
    };
}

const chains: RelayerChain[] = [
    evmChain({
        namespace: config.namespace,
        chain: sepolia,
        rpcUrl: config.rpcUrl,
        build: (client, submitter) => new Erc7579RecoveryModuleSettlement({ chainId: config.chainId, client, submitter, submitterAddress: privateKeyToAccount(config.roles.relayer.on(config.namespace).privateKey as Hex).address }),
        extra: { recoveryModuleAddress: MODULE_ADDRESS },
    }),
    evmChain({
        namespace: config.arbitrumSepolia.namespace,
        chain: arbitrumSepolia,
        rpcUrl: config.arbitrumSepolia.rpcUrl,
        build: (client, submitter) => new Eip7702RecoveryAccountSettlement({ chainId: config.arbitrumSepolia.chainId, client, submitter }),
        extra: { implementation: eip7702AccountAddress(config.arbitrumSepolia.chainId) },
    }),
];

// Mounted only when Solana is configured. An absent chain answers 404 from the relayer, which is the
// honest version of "this chain is not set up".
if (config.solana !== null) {
    const solana = config.solana;
    const programIdBase58 = recoveryVaultProgramIds[solana.cluster];
    if (programIdBase58 === undefined) {
        throw new Error(
            `The recovery vault program has no deployment on ${solana.cluster} (known: ${Object.keys(recoveryVaultProgramIds).join(", ")}). ` +
            "Set SOLANA_CLUSTER to one of those, or leave SOLANA_RPC_URL empty to run without Solana roles.",
        );
    }
    const programId = new PublicKey(programIdBase58);
    const connection = new Connection(solana.rpcUrl, "confirmed");
    // SLIP-0010 yields the 32-byte seed; `fromSeed` expands it to the 64-byte secret key web3.js wants.
    const keypairFor = (hex: string) => Keypair.fromSeed(hexToBytes(hex));
    const relayer = keypairFor(config.roles.relayer.on(solana.namespace).privateKey);
    const pause = keypairFor(config.roles.pause.on(solana.namespace).privateKey);
    const resume = config.roles.resume.map((role) => keypairFor(role.on(solana.namespace).privateKey));
    const direct = solanaDirectSubmitter({ connection, relayer, programId, feePayerMaxLamports: solana.feePayerMaxLamports });

    const quorum: QuorumSigner = {
        members: resume.map((keypair) => ({ namespace: solana.namespace, id: keypair.publicKey.toBase58() })),
        threshold: config.resumeThreshold,
        async sign(digest) {
            return resume.slice(0, config.resumeThreshold).map((keypair) => ({
                authority: { namespace: solana.namespace, id: keypair.publicKey.toBase58() },
                signature: ed25519.sign(digest, keypair.secretKey.slice(0, 32)),
            }));
        },
    };

    chains.push({
        adapter: new SolanaRecoveryVaultSettlement({ cluster: solana.cluster, connection, submitter: direct, programId, vaultSeed: DEMO_VAULT_SEED }),
        direct,
        publish: {
            relayer: relayer.publicKey.toBase58(),
            pauseAuthority: pause.publicKey.toBase58(),
            resumeMembers: resume.map((keypair) => keypair.publicKey.toBase58()),
            resumeThreshold: config.resumeThreshold,
            timelockSeconds: config.timelockSeconds,
            pauseCeilingSeconds: config.pauseCeilingSeconds,
            extra: { programId: programId.toBase58(), cluster: solana.cluster, feePayerMaxLamports: solana.feePayerMaxLamports.toString() },
        },
        fund: {
            max: solana.fundMaxLamports,
            async send(to, amount) {
                const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: new PublicKey(to), lamports: Number(amount) }));
                return { hash: await sendAndConfirmTransaction(connection, tx, [relayer], { commitment: "confirmed" }) };
            },
        },
        operators: { pause: solanaOwnerExecutor({ connection, owner: pause, namespace: solana.namespace }), resume: quorum },
    });
}

const relayer = new RelayerService({
    chains,
    // Relaying is open: the authority is the signature in the body, and an open relayer costs the
    // operator gas, not custody. The faucet and the operator's own keys are behind the demo's secrets.
    fundCredentialHashes: [hashCredential(config.recordAppendSecret)],
    operatorCredentialHashes: [hashCredential(config.watchRegisterSecret)],
    log: (line) => logInfo("relayer", line),
});
app.all(/^\/api\/relay(\/.*)?$/, (req, res, next) => {
    void relayer
        .handle({ method: req.method, path: req.path.replace(/^\/api\/relay/, "") || "/", headers: req.headers as Record<string, string>, body: req.body })
        .then(({ status, body }) => res.status(status).json(body))
        .catch(next);
});

// --- The record host and the watchtower ---------------------------------------------------------

// Holds ciphertext and per-chain context, never a seal and never a key.
app.use("/api", createRecordsRouter({
    store: new LocalSealedDataStore({ directory: config.recordsDir, domain: "demo-record-host" }),
    appendSecret: config.recordAppendSecret,
    log: (message) => logInfo("records", message),
}));

// Holds watches, never keys. Arbitrum is not here: no probe reads the 7702 account's views yet.
const watchProbes: WatchProbe[] = [
    new NihiliumRevealProbe(),
    new EvmRecoveryProbe({ rpcUrls: { [config.namespace]: config.rpcUrl } }),
    ...(config.solana === null ? [] : [new SolanaRecoveryProbe({ rpcUrls: { [config.solana.namespace]: config.solana.rpcUrl } })]),
];
const watchtower = createWatchtower({
    store: new LocalWatchStore({ directory: config.watchesDir, domain: "demo-watchtower", heartbeatSeconds: config.watchtowerPollSeconds }),
    probes: watchProbes,
    registerSecret: config.watchRegisterSecret,
    pollIntervalSeconds: config.watchtowerPollSeconds,
    allowForcedPoll: config.allowForcedPoll,
    log: (message) => logInfo("watchtower", message),
});
app.use("/api/watchtower", watchtower.router);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logError("http", "unhandled error", error);
    res.status(500).json({ error: "Internal error." });
});

/** A `0x`-prefixed hex key as bytes. */
function hexToBytes(hex: string): Uint8Array {
    const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(bare.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
    return out;
}

process.on("unhandledRejection", (reason) => logError("process", "unhandled rejection", reason));
process.on("uncaughtException", (error) => logError("process", "uncaught exception", error));

app.listen(config.port, () => {
    void printBootBanner(config, MODULE_ADDRESS);
    // The loop is the host's, never the package's.
    watchtower.startPolling();
});
