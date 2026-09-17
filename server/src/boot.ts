/**
 * The boot banner.
 *
 * The roles are the lesson of this repo, and this is where a reader first meets them: separate
 * identities, separate routes, printed side by side with the chain they act on. It also prints the
 * two things that silently break a demo — a relayer with no gas, and roles that share a seed.
 */
import { createPublicClient, formatEther, http } from "viem";
import type { Config } from "./config.js";
import type { RoleIdentity } from "./roleIdentity.js";
import { logInfo, logWarn } from "./log.js";

/** Below this, `initiateRecovery` / `executeRecovery` will fail on Sepolia. */
const LOW_BALANCE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

export async function printBootBanner(config: Config, moduleAddress: string): Promise<void> {
    const client = createPublicClient({ transport: http(config.rpcUrl) });

    const roles: { label: string; identity: RoleIdentity; routes: string }[] = [
        { label: "relayer", identity: config.roles.relayer, routes: "POST /api/roles/relayer/{initiate,execute,fund}" },
        { label: "pause authority", identity: config.roles.pause, routes: "POST /api/roles/veto/pause" },
        { label: "abort authority", identity: config.roles.abort, routes: "POST /api/roles/veto/abort" },
        ...config.roles.resume.map((identity, i) => ({
            label: `resume member ${i + 1}`,
            identity,
            routes: i === 0 ? "POST /api/roles/veto/resume" : "",
        })),
    ];

    // Balance is carried on the row rather than in a parallel array: two arrays that must stay
    // index-aligned is how a banner ends up printing one role's balance under another's name.
    const rows = await Promise.all(
        roles.map(async (role) => {
            // One chain today. When roles act on a second, this becomes a row per (role, chain) —
            // which is why the key is asked for per namespace rather than held on the role.
            const key = role.identity.on(config.namespace);
            try {
                return { ...role, key, balance: await client.getBalance({ address: key.authority.id as `0x${string}` }) };
            } catch {
                // An unreadable balance must not read as an empty one.
                return { ...role, key, balance: null };
            }
        }),
    );

    logInfo("boot", `listening on :${config.port}`, {
        chain: config.namespace,
        rpc: config.rpcUrl,
        module: moduleAddress,
    });
    console.log("");
    console.log(`  roles — separate identities, separate routes, on ${config.namespace}`);
    for (const row of rows) {
        const shown =
            row.balance === null ? " balance unreadable" : `${formatEther(row.balance).padStart(10)} ETH`;
        console.log(`    ${row.label.padEnd(18)} ${row.key.authority.id}  ${shown}  ${row.routes}`);
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
            `${derived.length} role(s) derived from one phrase (${
                config.roleMnemonic.split(" ").slice(0, 2).join(" ")
            }…) — convenient here, and the exact failure this repo is about in production: roles that ` +
                "share a seed are one party wearing several hats. Set each role's key in server/.env " +
                "to separate them.",
        );
    }
    const relayer = rows.find((r) => r.label === "relayer");
    if (relayer?.balance != null && relayer.balance < LOW_BALANCE_WEI) {
        logWarn("boot", "relayer is below 0.01 ETH — initiate/execute will fail", {
            address: relayer.key.authority.id,
            faucet: "https://sepoliafaucet.com",
        });
    }
    console.log(
        "    The three veto roles hold three DIFFERENT keys. One key playing all three looks",
    );
    console.log("    correctly configured and is worth nothing. See CLAUDE.md -> Roles.");
    console.log("");
}
