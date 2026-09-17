/**
 * The demo's server: every role that cannot run in a browser, each on its own router.
 *
 * Routers land per milestone (records and watchtower wrap the SDK's own services; veto and relayer
 * hold the Sepolia keys). This file is the only one that reads `config` — everything under
 * `roles/` is handed what it needs.
 */
import cors from "cors";
import express from "express";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { printBootBanner } from "./boot.js";
import { config } from "./config.js";
import { logError, logInfo } from "./log.js";

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

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logError("http", "unhandled error", error);
    res.status(500).json({ error: "Internal error." });
});

process.on("unhandledRejection", (reason) => logError("process", "unhandled rejection", reason));
process.on("uncaughtException", (error) => logError("process", "uncaught exception", error));

app.listen(config.port, () => {
    void printBootBanner(config, MODULE_ADDRESS);
});
