/**
 * Every chain's veto clock at once — because a recovery is not finished until the slowest one is.
 *
 * Reads each chain through its settlement adapter, polled at two cadences: six seconds while a clock
 * is running, a minute while nothing is. The default devnet endpoint rate-limits aggressively, and a
 * read error on this screen is deliberately not treated as "all clear".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AttemptClock, VetoState } from "@nihilium/recovery-core";
import { predatesRegistration } from "@nihilium/recovery-veto";
import type { VaultRecord } from "@nihilium/recovery-sdk";
import type { AppBindings } from "../wiring.js";

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
    /** Why this chain could not be read, if it could not. `unknown` never renders as "all clear". */
    unreadable: string | null;
}

/** One account whose recovery attempt is worth reading, from what a vault or handover row recorded. */
export interface AttemptTarget {
    chainId: string;
    accountId: string;
    /** Solana only: who created the vault PDA, which seeds its address. */
    creator: string | null;
    vaultId: string;
    /** When this vault registered its key on the chain. Older finished attempts are history. */
    since?: number;
}

const POLL_RUNNING_MS = 6_000;
const POLL_IDLE_MS = 60_000;

export function useTimelocks(bindings: AppBindings, vault: VaultRecord | null): { rows: readonly TimelockRow[]; refresh: () => void } {
    const targets = useMemo(
        () => vault === null ? [] : vault.chains.map((record) => ({
            chainId: record.chainId, accountId: record.accountId, creator: record.signerAddress ?? null, vaultId: vault.vaultId, since: record.addedAt,
        })),
        [vault],
    );
    return useAttempts(bindings, targets);
}

/** Reads and polls every target's attempt. Shared by the timelock box and the handover view. */
export function useAttempts(bindings: AppBindings, targets: readonly AttemptTarget[]): { rows: readonly TimelockRow[]; refresh: () => void } {
    const [rows, setRows] = useState<readonly TimelockRow[]>([]);
    const [nonce, setNonce] = useState(0);
    const refresh = useRef(() => setNonce((n) => n + 1)).current;
    const key = useMemo(() => targets.map((t) => `${t.vaultId}:${t.chainId}:${t.accountId}`).sort().join(","), [targets]);
    const interval = rows.some((row) => row.projected === "INITIATED" || row.projected === "PAUSED") ? POLL_RUNNING_MS : POLL_IDLE_MS;

    useEffect(() => {
        if (key === "") return;
        let live = true;
        async function readAll(): Promise<void> {
            const next = await Promise.all(targets.map((target) => readOne(bindings, target)));
            if (live) setRows(next.filter((row): row is TimelockRow => row !== null));
        }
        void readAll();
        const timer = window.setInterval(() => void readAll(), interval);
        return () => {
            live = false;
            window.clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `targets`
    }, [bindings, key, nonce, interval]);

    return { rows: key === "" ? NO_ROWS : rows, refresh };
}

const NO_ROWS: readonly TimelockRow[] = [];

/** `null` for a chain this build cannot read at all, which is not the same as one that read empty. */
async function readOne(bindings: AppBindings, target: AttemptTarget): Promise<TimelockRow | null> {
    const chain = bindings.chains.get(target.chainId);
    if (chain === undefined || chain.settlement === null) return null;
    const base = { chainId: target.chainId, chainLabel: chain.label, accountId: target.accountId, vaultId: target.vaultId };
    try {
        const state = await chain.settlement.readState({ namespace: chain.namespace, accountId: target.accountId, ...(target.creator ? { signerAddress: target.creator } : {}) });
        // A construction that keeps its last attempt across a re-register: one that finished before
        // this vault's key is not this vault's.
        if (!state.installed || predatesRegistration(state.clock, target.since)) return { ...base, projected: null, clock: null, unreadable: null };
        return { ...base, projected: state.attempt, clock: state.clock, unreadable: null };
    } catch (error) {
        return { ...base, projected: null, clock: null, unreadable: describe(error) };
    }
}

/** Something a reader can act on, whatever was thrown: web3.js and Anchor both throw errors with empty messages. */
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
        // Circular, or a host object.
    }
    return `a ${typeof error} this app could not describe`;
}
