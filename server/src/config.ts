/**
 * The server's whole configuration, read once. Validation is a handful of lines on purpose — a
 * schema library here would be more machinery than the thing it validates.
 *
 * Nothing under `roles/` imports this file: every role takes what it needs as a constructor
 * parameter, which is what makes those directories liftable (CLAUDE.md -> The copy line).
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { roleKey, type RoleKey } from "./demoKeys.js";

loadDotenv();

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} is not a number: "${raw}"`);
    return value;
}

function str(name: string, fallback: string): string {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? fallback : raw === "true" || raw === "1";
}

const resumeKeys = str("RESUME_MEMBER_PRIVATE_KEYS", "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");

/** How many resume members exist when `.env` names none. Three, because a 1-of-1 quorum teaches nothing. */
const DEFAULT_RESUME_MEMBERS = 3;

export interface Config {
    port: number;
    corsOrigin: string;
    chainId: number;
    rpcUrl: string;
    keys: { relayer: RoleKey; pause: RoleKey; abort: RoleKey; resume: RoleKey[] };
    resumeThreshold: number;
    /** Seconds. Demo values: long enough to see, short enough to sit through. */
    timelockSeconds: number;
    pauseCeilingSeconds: number;
    recordsDir: string;
    watchesDir: string;
    recordAppendSecret: string;
    watchRegisterSecret: string;
    watchtowerPollSeconds: number;
    /** Adds a `POST /poll` route the watchtower's own API does not have. Demo affordance, off in prod. */
    allowForcedPoll: boolean;
    /** Ceiling on `POST /api/roles/relayer/fund`, in wei. */
    fundMaxWei: bigint;
}

const memberCount = resumeKeys.length > 0 ? resumeKeys.length : DEFAULT_RESUME_MEMBERS;

export const config: Config = {
    port: num("PORT", 8787),
    corsOrigin: str("CORS_ORIGIN", "http://localhost:5173"),
    chainId: num("CHAIN_ID", 11155111),
    rpcUrl: str("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
    keys: {
        relayer: roleKey("relayer", process.env["RELAYER_PRIVATE_KEY"], 0),
        pause: roleKey("pause", process.env["PAUSE_AUTHORITY_PRIVATE_KEY"], 1),
        abort: roleKey("abort", process.env["ABORT_AUTHORITY_PRIVATE_KEY"], 2),
        resume: Array.from({ length: memberCount }, (_, i) =>
            roleKey(`resume-${i + 1}`, resumeKeys[i], 10 + i),
        ),
    },
    // 2 of 3 by default. `validateVetoConfig` refuses a threshold of 1 unless a caller declares the
    // account low-value, and it is right to: a one-member quorum is a second pause key.
    resumeThreshold: num("RESUME_THRESHOLD", 2),
    timelockSeconds: num("TIMELOCK_SECONDS", 300),
    pauseCeilingSeconds: num("PAUSE_CEILING_SECONDS", 900),
    recordsDir: resolve(str("RECORDS_DIR", "./.data/records")),
    watchesDir: resolve(str("WATCHES_DIR", "./.data/watches")),
    recordAppendSecret: str("RECORD_APPEND_SECRET", "demo-append-secret"),
    watchRegisterSecret: str("WATCH_REGISTER_SECRET", "demo-watch-secret"),
    // 15s, not the README's 300s: a scenario that waits five minutes for an alarm teaches nothing.
    // The banner prints it so nobody reads the demo's cadence as a recommendation.
    watchtowerPollSeconds: num("WATCHTOWER_POLL_SECONDS", 15),
    allowForcedPoll: bool("DEMO_ALLOW_FORCED_POLL", true),
    fundMaxWei: BigInt(str("DEMO_FUND_MAX_WEI", "20000000000000000")),
};
