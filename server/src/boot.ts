/**
 * The boot banner.
 *
 * The roles are the lesson of this repo, and this is where a reader first meets them: separate
 * identities, separate routes, printed side by side with the chain they act on. It also prints the
 * two things that silently break a demo — a relayer with no gas, and roles that share a seed.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, formatEther, http } from "viem";
import type { Config } from "./config.js";
import { ROLE_CHAINS, type RoleIdentity } from "./roleIdentity.js";
import { logInfo, logWarn } from "./log.js";

/** Below this, `initiateRecovery` / `executeRecovery` will fail on Sepolia. */
const LOW_BALANCE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

/** Below this, a Solana relayer cannot pay for an initiate, an execute, or a vault's rent. */
const LOW_BALANCE_LAMPORTS = 50_000_000n; // 0.05 SOL

/** One chain's display rules, so the banner never prints lamports under an ETH heading. */
interface ChainDisplay {
    namespace: string;
    label: string;
    format(balance: bigint): string;
    low: bigint;
    balanceOf(address: string): Promise<bigint>;
    /** Route prefix, because the same role answers on a different path per chain. */
    prefix: string;
}

export async function printBootBanner(config: Config, moduleAddress: string): Promise<void> {
    const evmClient = createPublicClient({ transport: http(config.rpcUrl) });

    const chains: ChainDisplay[] = [
        {
            namespace: config.namespace,
            label: "sepolia",
            format: (b) => `${formatEther(b).padStart(10)} ETH`,
            low: LOW_BALANCE_WEI,
            balanceOf: (address) => evmClient.getBalance({ address: address as `0x${string}` }),
            prefix: "/api/roles",
        },
    ];

    if (config.solana !== null) {
        const solana = config.solana;
        const connection = new Connection(solana.rpcUrl, "confirmed");
        chains.push({
            namespace: solana.namespace,
            label: solana.cluster,
            format: (b) => `${(Number(b) / 1e9).toFixed(4).padStart(10)} SOL`,
            low: LOW_BALANCE_LAMPORTS,
            balanceOf: async (address) =>
                BigInt(await connection.getBalance(new PublicKey(address), "confirmed")),
            prefix: "/api/roles/*/solana",
        });
    }

    const roles: { label: string; identity: RoleIdentity; routes: string }[] = [
        { label: "relayer", identity: config.roles.relayer, routes: "POST /api/roles/relayer/{initiate,execute,fund}" },
        { label: "pause authority", identity: config.roles.pause, routes: "POST /api/roles/veto/pause" },
        ...config.roles.resume.map((identity, i) => ({
            label: `resume member ${i + 1}`,
            identity,
            routes: i === 0 ? "POST /api/roles/veto/resume" : "",
        })),
    ];

    // A row per (role, chain), which is what this file always said it would become: the key is
    // asked for per namespace rather than held on the role, precisely so a party can have one on
    // each. A role with no scheme on a chain is skipped rather than shown empty — it is not a
    // party with no money, it is a party that does not act there.
    //
    // Balance is carried on the row rather than in a parallel array: two arrays that must stay
    // index-aligned is how a banner ends up printing one role's balance under another's name.
    const rows = (
        await Promise.all(
            chains.flatMap((chain) =>
                roles.map(async (role) => {
                    if (ROLE_CHAINS[chain.namespace] === undefined) return null;
                    const key = role.identity.on(chain.namespace);
                    try {
                        return { ...role, chain, key, balance: await chain.balanceOf(key.authority.id) };
                    } catch {
                        // An unreadable balance must not read as an empty one.
                        return { ...role, chain, key, balance: null };
                    }
                }),
            ),
        )
    ).filter((row) => row !== null);

    logInfo("boot", `listening on :${config.port}`, {
        chain: config.namespace,
        rpc: config.rpcUrl,
        module: moduleAddress,
    });
    console.log("");
    console.log("  roles — separate identities, separate routes, one key per chain they act on");
    for (const chain of chains) {
        const onChain = rows.filter((row) => row.chain.namespace === chain.namespace);
        if (onChain.length === 0) continue;
        console.log(`    ${chain.label}  (${chain.namespace})`);
        for (const row of onChain) {
            const shown = row.balance === null ? " balance unreadable" : chain.format(row.balance);
            // A role with no routes on this chain prints none. The Solana veto is unbuilt, and a
            // banner advertising a route that 404s is worse than a blank column.
            const routes =
                chain.prefix === "/api/roles"
                    ? row.routes
                    : row.label === "relayer"
                      ? "POST /api/roles/relayer/solana/{initiate,execute,fund,feepayer}"
                      : "— no route on this chain yet";
            console.log(
                `      ${row.label.padEnd(18)} ${row.key.authority.id.padEnd(44)} ${shown}  ${routes}`,
            );
        }
    }
    if (config.solana === null) {
        // Not "no Solana roles" — "Solana is not configured". A reader must not read an absent
        // chain as a chain that is fine.
        console.log("    solana             not configured — set SOLANA_RPC_URL to mount its routes");
    }
    console.log(
        `    resume quorum      ${config.resumeThreshold}-of-${config.roles.resume.length}` +
            `   timelock ${config.timelockSeconds}s   pause ceiling ${config.pauseCeilingSeconds}s`,
    );
    console.log("");
    console.log(`    record host        ${config.recordsDir}`);
    console.log(`                       GET|POST /api/records/:id — ciphertext only, never a seal`);
    console.log(`    watchtower         ${config.watchesDir}`);
    console.log(`                       polling every ${config.watchtowerPollSeconds}s — holds no keys`);
    console.log("");

    const derived = rows.filter((r) => !r.key.supplied);
    if (derived.length > 0) {
        logWarn(
            "boot",
            `${derived.length} role-chain key(s) derived from one phrase (${
                config.roleMnemonic.split(" ").slice(0, 2).join(" ")
            }…) — convenient here, and the exact failure this repo is about in production: roles that ` +
                "share a seed are one party wearing several hats. Set each role's key in server/.env " +
                "to separate them.",
        );
    }
    for (const relayer of rows.filter((r) => r.label === "relayer")) {
        if (relayer.balance === null || relayer.balance >= relayer.chain.low) continue;
        logWarn("boot", `relayer is low on ${relayer.chain.label} — initiate/execute will fail`, {
            address: relayer.key.authority.id,
            balance: relayer.chain.format(relayer.balance).trim(),
            faucet:
                relayer.chain.namespace === config.namespace
                    ? "https://sepoliafaucet.com"
                    : "solana airdrop 2 <address> --url devnet",
        });
    }
    console.log(
        "    The three veto roles hold three DIFFERENT keys. One key playing all three looks",
    );
    console.log("    correctly configured and is worth nothing. See CLAUDE.md -> Roles.");
    console.log("");
}
