/**
 * The demo's server: every role that cannot run in a browser, each on its own router.
 *
 * Routers land per milestone (records and watchtower wrap the SDK's own services; veto and relayer
 * hold the Sepolia keys). This file is the only one that reads `config` — everything under
 * `roles/` is handed what it needs.
 */
import cors from "cors";
import express from "express";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { recoveryVaultProgramIds } from "@nihilium/recovery-onchain-solana";
import { printBootBanner } from "./boot.js";
import { config } from "./config.js";
import { logError, logInfo } from "./log.js";
import { createRelayerRouter } from "./roles/relayer/index.js";
import { createSolanaRelayerRouter } from "./roles/relayer/solana.js";
import { createVetoRouter } from "./roles/veto/index.js";

// From the SDK's address book, never a literal: the v1 -> v2 redeploy moved this address, and a
// hardcoded copy would have kept pointing at the superseded module while looking correct.
const MODULE_ADDRESS = recoveryModuleAddress(config.chainId);

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
        const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`;
        logInfo("http", line);
    });
    next();
});

app.get("/health", (_req, res) => {
    res.json({ ok: true, chainId: config.chainId, module: MODULE_ADDRESS });
});

// Built here, not inside the roles: `config` stops at this file, which is what keeps every directory
// under `roles/` liftable into another codebase (CLAUDE.md -> The copy line).
const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(config.rpcUrl),
}) as PublicClient;

/** One wallet client per role, each bound to its own key at construction and never re-pointed. */
function walletFor(privateKeyHex: string) {
    const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
    return {
        account,
        address: account.address as Address,
        client: createWalletClient({ account, chain: sepolia, transport: http(config.rpcUrl) }),
    };
}

const relayerKey = walletFor(config.roles.relayer.on(config.namespace).privateKey);
const pauseKey = walletFor(config.roles.pause.on(config.namespace).privateKey);
const resumeKeys = config.roles.resume.map((role) => walletFor(role.on(config.namespace).privateKey));

app.use(
    "/api/roles/relayer",
    createRelayerRouter({
        publicClient,
        walletClient: relayerKey.client,
        relayer: relayerKey.address,
        moduleAddress: MODULE_ADDRESS as Address,
        fundMaxWei: config.fundMaxWei,
        vetoConfig: {
            pauseAuthority: pauseKey.address,
            resumeMembers: resumeKeys.map((k) => k.address),
            resumeThreshold: config.resumeThreshold,
            timelockSeconds: config.timelockSeconds,
            pauseCeilingSeconds: config.pauseCeilingSeconds,
        },
        log: (message) => logInfo("relayer", message),
    }),
);

app.use(
    "/api/roles/veto",
    createVetoRouter({
        publicClient,
        moduleAddress: MODULE_ADDRESS as Address,
        pause: { client: pauseKey.client, address: pauseKey.address },
        resume: {
            signers: resumeKeys.map((k) => k.account),
            // The relayer submits, because `resume` verifies the signatures rather than the sender —
            // so the quorum never needs gas of its own.
            submitter: { client: relayerKey.client, address: relayerKey.address },
        },
        resumeThreshold: config.resumeThreshold,
        log: (message) => logInfo("veto", message),
    }),
);

// Mounted only when Solana is configured. An absent route answers 404, which is the honest
// version of "this chain is not set up" — a stub that returned success would be worse than nothing.
if (config.solana !== null) {
    const solana = config.solana;
    // The address book, never a literal — the same reason `MODULE_ADDRESS` comes from the SDK. A
    // cluster the program was built for but never deployed to fails here, loudly, rather than at
    // the first transaction against an address with no code.
    const programId = recoveryVaultProgramIds[solana.cluster];
    if (programId === undefined) {
        throw new Error(
            `The recovery vault program has no deployment on ${solana.cluster} (known: ` +
                `${Object.keys(recoveryVaultProgramIds).join(", ")}). Set SOLANA_CLUSTER to one of ` +
                "those, or leave SOLANA_RPC_URL empty to run without Solana roles.",
        );
    }
    const relayerSeed = config.roles.relayer.on(solana.namespace).privateKey;
    app.use(
        "/api/roles/relayer/solana",
        createSolanaRelayerRouter({
            connection: new Connection(solana.rpcUrl, "confirmed"),
            // SLIP-0010 yields the 32-byte seed; `fromSeed` expands it to the 64-byte secret key
            // web3.js wants. `fromSecretKey` on the seed would throw, not silently differ.
            relayer: Keypair.fromSeed(hexToBytes32(relayerSeed)),
            programId: new PublicKey(programId),
            cluster: solana.cluster,
            fundMaxLamports: solana.fundMaxLamports,
            feePayerMaxLamports: solana.feePayerMaxLamports,
            vetoConfig: {
                // The same parties as on Sepolia, each with its own key on this chain — which is
                // the premise of `roleIdentity.ts`: a role is a party, not a key.
                pauseAuthority: config.roles.pause.on(solana.namespace).authority.id,
                resumeMembers: config.roles.resume.map(
                    (role) => role.on(solana.namespace).authority.id,
                ),
                resumeThreshold: config.resumeThreshold,
                timelockSeconds: config.timelockSeconds,
                pauseCeilingSeconds: config.pauseCeilingSeconds,
            },
            log: (message) => logInfo("relayer", message),
        }),
    );
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logError("http", "unhandled error", error);
    res.status(500).json({ error: "Internal error." });
});

/** A `0x`-prefixed 32-byte hex key as bytes. `Keypair.fromSeed` takes the seed, not a hex string. */
function hexToBytes32(hex: string): Uint8Array {
    const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
    return out;
}

process.on("unhandledRejection", (reason) => logError("process", "unhandled rejection", reason));
process.on("uncaughtException", (error) => logError("process", "uncaught exception", error));

app.listen(config.port, () => {
    void printBootBanner(config, MODULE_ADDRESS);
});
