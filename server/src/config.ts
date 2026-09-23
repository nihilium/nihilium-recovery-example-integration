/**
 * The server's whole configuration, read once. Validation is a handful of lines on purpose — a
 * schema library here would be more machinery than the thing it validates.
 *
 * Nothing under `roles/` imports this file: every role takes what it needs as a constructor
 * parameter, which is what makes those directories liftable (CLAUDE.md -> The copy line).
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { SOLANA_NAMESPACE } from "@nihilium/recovery-key-solana";
import { createRoleIdentity, type RoleIdentity } from "./roleIdentity.js";

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

/**
 * A value with no sensible default.
 *
 * The two shared credentials are capabilities matched against the app's copy, so a fallback would be
 * a credential every clone of this repository shares. `ROLE_MNEMONIC` is here for a sharper reason:
 * it used to fall back to the published Hardhat phrase, whose addresses anyone can derive — and
 * does. Role keys hold gas and veto authority. A demo that silently ran on a public phrase would be
 * teaching that that is fine.
 */
function required(name: string): string {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") {
        throw new Error(
            `${name} is not set. Run \`npm run setup:env\` at the repository root — it writes ` +
                "server/.env and app/.env.local with one matching pair of generated secrets.",
        );
    }
    return raw;
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
    /** CAIP-2 for the chain the roles act on. The key for `ROLE_CHAINS`, and a KDF input elsewhere. */
    namespace: string;
    rpcUrl: string;
    /**
     * Roles are account indices against this phrase, so one phrase gives every role a key on every
     * chain, each in that chain's own curve and path. Per-role `.env` keys still override, which is
     * what a real deployment does — see `roleIdentity.ts`.
     */
    roleMnemonic: string;
    roles: {
        relayer: RoleIdentity;
        pause: RoleIdentity;
        resume: RoleIdentity[];
        /**
         * Vouches for module *code*, and for nothing else.
         *
         * A genuinely different party from the veto roles: those decide whether one recovery may
         * proceed, this one decides which modules an account will install at all. Safe7579 routes
         * every install through the ERC-7484 registry, so without an attester the account cannot
         * install the recovery module — see `server/scripts/attest-modules.ts`.
         */
        attester: RoleIdentity;
    };
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
    /**
     * Solana, or `null` when `SOLANA_RPC_URL` is unset.
     *
     * `null` means the Solana routes are not mounted and the banner says the chain is not
     * configured. It must never read as "fine": a relayer that is absent and a relayer that is
     * funded look identical to a caller that does not check.
     */
    solana: SolanaConfig | null;
}

export interface SolanaConfig {
    /** CAIP-2, from the SDK. `solana:devnet` is not a chain id. */
    namespace: string;
    /**
     * The cluster whose tag the deployed program was built with.
     *
     * Folded into every digest the program checks, so a wrong value here produces signatures it
     * rejects without saying why — which is why it is validated at boot rather than at the first
     * transaction.
     */
    cluster: SolanaCluster;
    rpcUrl: string;
    /** Ceiling on `POST /api/roles/relayer/solana/fund`, in lamports. */
    fundMaxLamports: bigint;
    /**
     * Ceiling on what one `/feepayer` co-sign may cost the relayer.
     *
     * Covers **rent as well as fees**: `create_vault` allocates PDAs whose rent-exemption deposit
     * comes from the payer, so a limit tuned to transaction fees alone refuses every vault.
     */
    feePayerMaxLamports: bigint;
}

/**
 * The clusters a role can act on. A string outside this set is a typo, not a network.
 *
 * **`localnet` is deliberately absent**, although the program is built for it. CAIP-2 for Solana is
 * the truncated genesis hash, and a local validator's genesis is whatever `solana-test-validator`
 * minted this morning — there is no fixed namespace to name it by. Since the namespace is a KDF
 * input, a role on localnet would be a role whose keys nobody else can reproduce.
 */
const SOLANA_CLUSTERS = ["devnet", "mainnet-beta"] as const;
export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number];

function solanaCluster(): SolanaCluster {
    const declared = str("SOLANA_CLUSTER", "devnet");
    if (!(SOLANA_CLUSTERS as readonly string[]).includes(declared)) {
        throw new Error(
            `SOLANA_CLUSTER="${declared}" is not a cluster this program is built for ` +
                `(${SOLANA_CLUSTERS.join(", ")}). The cluster tag is folded into every digest, so a ` +
                "wrong one yields signatures the program rejects without naming a cause.",
        );
    }
    return declared as SolanaCluster;
}

function solanaConfig(): SolanaConfig | null {
    const rpcUrl = str("SOLANA_RPC_URL", "");
    if (rpcUrl === "") return null;
    const cluster = solanaCluster();
    return {
        // Keyed by cluster rather than assumed: the namespace is a KDF input on both halves, and
        // the app derives the same one from `SOLANA_NAMESPACE`.
        namespace: SOLANA_NAMESPACE[cluster],
        cluster,
        rpcUrl,
        // 1 SOL. Devnet is free and the faucet is unreliable, so this is generous on purpose.
        fundMaxLamports: BigInt(str("DEMO_FUND_MAX_LAMPORTS", "1000000000")),
        // 0.1 SOL. A vault's two PDAs cost well under this in rent; a transaction asking for more
        // is not a vault.
        feePayerMaxLamports: BigInt(str("DEMO_FEEPAYER_MAX_LAMPORTS", "100000000")),
    };
}

const memberCount = resumeKeys.length > 0 ? resumeKeys.length : DEFAULT_RESUME_MEMBERS;

const chainId = num("CHAIN_ID", 11155111);

const roleOptions = {
    mnemonic: required("ROLE_MNEMONIC"),
    supplied: {
        relayer: process.env["RELAYER_PRIVATE_KEY"],
        pause: process.env["PAUSE_AUTHORITY_PRIVATE_KEY"],
        attester: process.env["ATTESTER_PRIVATE_KEY"],
        ...Object.fromEntries(resumeKeys.map((key, i) => [`resume-${i + 1}`, key])),
    },
};

export const config: Config = {
    port: num("PORT", 8787),
    corsOrigin: str("CORS_ORIGIN", "http://localhost:5173"),
    chainId,
    namespace: `eip155:${chainId}`,
    rpcUrl: str("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
    roleMnemonic: roleOptions.mnemonic,
    roles: {
        // The index is the role's identity across every chain, so it is fixed here and nowhere else.
        relayer: createRoleIdentity("relayer", 0, roleOptions),
        pause: createRoleIdentity("pause", 1, roleOptions),
        // Index 3, not 2: index 2 stays reserved for the abort authority it was assigned, because
        // role indices are identities and recycling one silently re-points a funded address.
        attester: createRoleIdentity("attester", 3, roleOptions),
        // No abort role. In this demo the abort authority is the wallet's own active EOA, signed in
        // the browser, so an owner who still holds their keys can kill a recovery started against
        // them. Index 2 stays unused rather than being recycled: role indices are identities.
        resume: Array.from({ length: memberCount }, (_, i) =>
            createRoleIdentity(`resume-${i + 1}`, 10 + i, roleOptions),
        ),
    },
    // 2 of 3 by default. `validateVetoConfig` refuses a threshold of 1 unless a caller declares the
    // account low-value, and it is right to: a one-member quorum is a second pause key.
    resumeThreshold: num("RESUME_THRESHOLD", 2),
    timelockSeconds: num("TIMELOCK_SECONDS", 300),
    pauseCeilingSeconds: num("PAUSE_CEILING_SECONDS", 900),
    recordsDir: resolve(str("RECORDS_DIR", "./.data/records")),
    watchesDir: resolve(str("WATCHES_DIR", "./.data/watches")),
    recordAppendSecret: required("RECORD_APPEND_SECRET"),
    watchRegisterSecret: required("WATCH_REGISTER_SECRET"),
    // 15s, not the README's 300s: a scenario that waits five minutes for an alarm teaches nothing.
    // The banner prints it so nobody reads the demo's cadence as a recommendation.
    watchtowerPollSeconds: num("WATCHTOWER_POLL_SECONDS", 15),
    allowForcedPoll: bool("DEMO_ALLOW_FORCED_POLL", true),
    fundMaxWei: BigInt(str("DEMO_FUND_MAX_WEI", "20000000000000000")),
    solana: solanaConfig(),
};
