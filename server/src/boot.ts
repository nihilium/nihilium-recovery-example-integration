/**
 * The boot banner.
 *
 * The roles are the lesson of this repo, and this is where a reader first meets them: separate
 * addresses, separate routes, printed side by side. It also prints the two things that silently
 * break a demo — a relayer with no gas, and role keys that share a seed.
 */
import { createPublicClient, formatEther, http } from "viem";
import type { Config } from "./config.js";
import { addressOf } from "./demoKeys.js";
import { logInfo, logWarn } from "./log.js";

/** Below this, `initiateRecovery` / `executeRecovery` will fail on Sepolia. */
const LOW_BALANCE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

export async function printBootBanner(config: Config, moduleAddress: string): Promise<void> {
    const client = createPublicClient({ transport: http(config.rpcUrl) });

    const roles = [
        { label: "relayer", key: config.keys.relayer, routes: "POST /api/roles/relayer/{initiate,execute,fund}" },
        { label: "pause authority", key: config.keys.pause, routes: "POST /api/roles/veto/pause" },
        { label: "abort authority", key: config.keys.abort, routes: "POST /api/roles/veto/abort" },
        ...config.keys.resume.map((key, i) => ({
            label: `resume member ${i + 1}`,
            key,
            routes: i === 0 ? "POST /api/roles/veto/resume" : "",
        })),
    ];

    // Balance is carried on the row rather than in a parallel array: two arrays that must stay
    // index-aligned is how a banner ends up printing one role's balance under another's name.
    const rows = await Promise.all(
        roles.map(async (role) => {
            try {
                return { ...role, balance: await client.getBalance({ address: addressOf(role.key) }) };
            } catch {
                // An unreadable balance must not read as an empty one.
                return { ...role, balance: null };
            }
        }),
    );

    logInfo("boot", `listening on :${config.port}`, {
        chain: config.chainId,
        rpc: config.rpcUrl,
        module: moduleAddress,
    });
    console.log("");
    console.log("  roles — separate keys, separate routes, on purpose");
    for (const row of rows) {
        const shown =
            row.balance === null ? " balance unreadable" : `${formatEther(row.balance).padStart(10)} ETH`;
        console.log(`    ${row.label.padEnd(18)} ${addressOf(row.key)}  ${shown}  ${row.routes}`);
    }
    console.log(
        `    resume quorum      ${config.resumeThreshold}-of-${config.keys.resume.length}` +
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
            `${derived.length} role key(s) derived from the PUBLIC demo mnemonic — stable across ` +
                "restarts, and known to anyone reading this repo. Fund with testnet dust only; set " +
                "them in server/.env to use your own.",
        );
    }
    const relayer = rows.find((r) => r.label === "relayer");
    if (relayer?.balance != null && relayer.balance < LOW_BALANCE_WEI) {
        logWarn("boot", "relayer is below 0.01 ETH — initiate/execute will fail", {
            address: addressOf(config.keys.relayer),
            faucet: "https://sepoliafaucet.com",
        });
    }
    console.log(
        "    The three veto roles hold three DIFFERENT keys. One key playing all three looks",
    );
    console.log("    correctly configured and is worth nothing. See CLAUDE.md -> Roles.");
    console.log("");
}
