/**
 * Every chain's veto clock at once — because a recovery is not finished until the slowest one is.
 *
 * `useSettlement` reads one chain: the one on screen. That is right for a protection badge and wrong
 * for a timelock, because a vault covers several chains and a user who has been shown the shorter of
 * two waits has been told the account is theirs before it is. So this reads them all, and the box
 * above the cards reports the **longest** remainder.
 *
 * Demo-shaped, and here rather than under `integration/`, for two reasons: it is React, and it
 * builds a client per chain from `DemoEnv`. The reads themselves are not — `readAttemptClock` on
 * each chain is the copyable part, and this only decides when to call them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import type { VetoState } from "@nihilium/recovery-core";
import {
    createModuleReader,
    readAttemptClock as readEvmAttemptClock,
} from "../integration/recovery/settlement/evm/reads.js";
import { readAttemptClock as readSolanaAttemptClock } from "../integration/recovery/settlement/solana/relay.js";
import { createVaultProgram, keypairFromSecret } from "../integration/recovery/settlement/solana/program.js";
import { solanaVaultAddresses } from "../integration/recovery/settlement/solana/addresses.js";
import type { AttemptClock } from "../integration/recovery/settlement/timelock.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { WalletSnapshot } from "./wallet.js";
import type { AppBindings } from "./bindings.js";

export interface TimelockRow {
    chainId: string;
    chainLabel: string;
    /** The account read, as the vault recorded it — never the active seed's by default. */
    accountId: string;
    vaultId: string;
    /** What to render, and what gates an execute. */
    projected: VetoState | null;
    /** The consistent snapshot. `null` where nothing is installed. */
    clock: AttemptClock | null;
    /**
     * Why this chain could not be read, if it could not.
     *
     * Present so an unreadable chain renders as unreadable. `unknown` never renders as "all clear" —
     * and here the failure mode is worse than usual, because "no clock" and "could not ask" look
     * identical and the first of them means *go ahead*.
     */
    unreadable: string | null;
}

/**
 * One account whose recovery attempt is worth reading.
 *
 * Everything here comes from what a **vault or handover row recorded**, never from the seed that
 * happens to be active. A recovery is for a vault whose seed is gone, so the active seed is usually
 * the wrong one: reading EVM at the active seed's Safe — which is what this did — reported some
 * other account's attempt, or none.
 */
export interface AttemptTarget {
    chainId: string;
    accountId: string;
    /** Solana only: who created the vault PDA, which seeds its address. `null` falls back. */
    creator: string | null;
    vaultId: string;
}

/**
 * Two cadences, because a chain with nothing happening does not need watching six times a minute.
 *
 * The countdown itself ticks in the component from one read, so polling is only ever about catching
 * something *another party* did — a pause, or a recovery somebody else submitted. While a clock is
 * running that is worth six seconds; while nothing is, it is not worth anything like it.
 *
 * This is not a micro-optimisation. The default devnet endpoint rate-limits aggressively and this
 * hook reads every chain in the vault, alongside `useSettlement` doing its own reads — so a fixed
 * fast poll spends the budget on chains reporting "nothing is happening" and then fails on the one
 * that matters. A 429 arrives as a read error, and a read error on this screen is deliberately not
 * treated as "all clear".
 */
const POLL_RUNNING_MS = 6_000;
const POLL_IDLE_MS = 60_000;

export function useTimelocks(
    bindings: AppBindings,
    vault: VaultRecord | null,
    wallet: WalletSnapshot | null,
): { rows: readonly TimelockRow[]; refresh: () => void } {
    const targets = useMemo(
        () =>
            vault === null
                ? []
                : vault.chains.map((record) => ({
                      chainId: record.chainId,
                      // The vault's recorded account — see `AttemptTarget`.
                      accountId: record.accountId,
                      creator: record.signerAddress ?? null,
                      vaultId: vault.vaultId,
                  })),
        [vault],
    );
    return useAttempts(bindings, wallet, targets);
}

/**
 * Reads and polls every target's attempt. Shared by the timelock box and the handover view so that
 * they report the same accounts from the same reads — they used to disagree because one read the
 * chain and the other never did.
 */
export function useAttempts(
    bindings: AppBindings,
    wallet: WalletSnapshot | null,
    targets: readonly AttemptTarget[],
): { rows: readonly TimelockRow[]; refresh: () => void } {
    const [rows, setRows] = useState<readonly TimelockRow[]>([]);
    const [nonce, setNonce] = useState(0);
    const refresh = useRef(() => setNonce((n) => n + 1)).current;

    // A string, so a new array with the same accounts does not restart polling.
    const key = useMemo(
        () => targets.map((t) => `${t.vaultId}:${t.chainId}:${t.accountId}`).sort().join(","),
        [targets],
    );

    // Derived from what the last read found, so the cadence follows the chain rather than a guess.
    const interval = rows.some(
        (row) => row.projected === "INITIATED" || row.projected === "PAUSED",
    )
        ? POLL_RUNNING_MS
        : POLL_IDLE_MS;

    useEffect(() => {
        if (wallet === null || key === "") return;
        let live = true;

        async function readAll(): Promise<void> {
            const next = await Promise.all(
                targets.map((target) => readOne(bindings, wallet!, target)),
            );
            if (live) setRows(next.filter((row): row is TimelockRow => row !== null));
        }

        void readAll();
        const timer = window.setInterval(() => void readAll(), interval);
        return () => {
            live = false;
            window.clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `targets`
    }, [bindings, key, wallet, nonce, interval]);

    // Rows from a previous target set are not shown for the new one.
    return { rows: key === "" ? NO_ROWS : rows, refresh };
}

const NO_ROWS: readonly TimelockRow[] = [];

/** `null` for a chain this build cannot read at all, which is not the same as one that read empty. */
async function readOne(
    bindings: AppBindings,
    wallet: WalletSnapshot,
    target: AttemptTarget,
): Promise<TimelockRow | null> {
    const { chainId } = target;
    const chain = bindings.chains.get(chainId);
    // Solana only, and only as the fee payer for the `.view()` simulation — no account of the
    // active seed's is *read*.
    const account = wallet.accounts[chainId]?.[0];
    if (chain === undefined || account === undefined) return null;

    const base = {
        chainId,
        chainLabel: chain.label,
        accountId: target.accountId,
        vaultId: target.vaultId,
    };
    try {
        if (chainId === "evm-sepolia") {
            const client = createPublicClient({
                chain: sepolia,
                transport: http(bindings.env.sepoliaRpcUrl),
            });
            const reader = createModuleReader(
                client,
                recoveryModuleAddress(bindings.env.chainId) as Address,
                chain.namespace,
            );
            const installed = await reader.isInitialized(target.accountId as Address);
            if (!installed) return { ...base, projected: null, clock: null, unreadable: null };
            const read = await readEvmAttemptClock(reader, target.accountId as Address);
            return { ...base, ...read, unreadable: null };
        }

        if (chainId === "solana-devnet") {
            const ctx = createVaultProgram({
                rpcUrl: bindings.env.solanaRpcUrl,
                cluster: "devnet",
                payer: keypairFromSecret(account.signer.exportPrivateKeyHex_DEMO_ONLY()),
            });
            // The vault's recorded creator, not the active seed's key. The PDA is seeded by whoever
            // made it and the seed is not reversible, so reading a vault that belongs to a seed this
            // browser no longer holds — the ordinary case for a recovery — needs the stored value.
            const creator = target.creator ?? account.signer.address;
            const addresses = solanaVaultAddresses({ cluster: "devnet", creator });
            const info = await ctx.connection.getAccountInfo(addresses.vault, "confirmed");
            // No vault account is "nothing is counting", not a failure — the same distinction the
            // protection badge draws between "not installed" and "not asked".
            if (info === null) return { ...base, projected: null, clock: null, unreadable: null };
            const read = await readSolanaAttemptClock(ctx, addresses);
            return { ...base, projected: read.projected, clock: read.clock, unreadable: null };
        }

        // A chain with no settlement wiring has no clock to report and is not a failure.
        return null;
    } catch (error) {
        return { ...base, projected: null, clock: null, unreadable: describe(error) };
    }
}

/**
 * Something a reader can act on, whatever was thrown.
 *
 * `error.message` alone renders as an empty string surprisingly often — web3.js and Anchor both
 * throw errors carrying their detail in `logs`, `cause` or the class name and nothing in `message`.
 * "could not read:" followed by nothing is worse than no message at all, because it looks like the
 * app has no idea rather than like it failed to ask the right question.
 */
function describe(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
        const detail = `${error.message}${cause}`.trim();
        return detail.length > 0 ? detail : `${error.name} with no message`;
    }
    if (typeof error === "string" && error.length > 0) return error;
    try {
        const json = JSON.stringify(error);
        if (json !== undefined && json !== "{}") return json;
    } catch {
        // Circular, or a host object. Fall through to the constructor name.
    }
    return `a ${typeof error} this app could not describe`;
}
