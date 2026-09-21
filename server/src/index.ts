/**
 * The demo's server: every role that cannot run in a browser, each on its own router.
 *
 * Routers land per milestone (records and watchtower wrap the SDK's own services; veto and relayer
 * hold the Sepolia keys). This file is the only one that reads `config` — everything under
 * `roles/` is handed what it needs.
 */
import cors from "cors";
import express from "express";
import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { printBootBanner } from "./boot.js";
import { config } from "./config.js";
import { logError, logInfo } from "./log.js";
import { createRelayerRouter } from "./roles/relayer/index.js";
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

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logError("http", "unhandled error", error);
    res.status(500).json({ error: "Internal error." });
});

process.on("unhandledRejection", (reason) => logError("process", "unhandled rejection", reason));
process.on("uncaughtException", (error) => logError("process", "uncaught exception", error));

app.listen(config.port, () => {
    void printBootBanner(config, MODULE_ADDRESS);
});
