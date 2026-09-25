/**
 * Can this vault's recovery be carried through on-chain? Asked before the ceremony, not after it.
 *
 * A recovery is paid, emails people, may ask for a passport scan, and spends the vault the moment it
 * opens. The chain can refuse the handover that follows for reasons that were true all along — no
 * module installed, a different vault's key registered, an attempt already running — and every one
 * of them is a few free reads away. So the reads come first.
 *
 * **Per chain, and never all-or-nothing.** Chains are protected independently. A vault whose Solana
 * account was never protected can still hand over its EVM account, and refusing the whole recovery
 * would cost the chain that works to save nothing on the chain that does not: that one cannot be
 * rescued by waiting, since protecting it now needs a fresh vault anyway. So a recovery is refused
 * only when **no** chain could be handed over, and otherwise each chain says what will happen to it.
 *
 * **To replace:** `handoverFor`, as in `run.ts`. **Assumes:** the chain records are the vault's own
 * — `recoveryPubKeyHex` exactly as `addChain()` returned it, never re-derived.
 */
import type { ChainHandover, HandoverAccount, HandoverProblem } from "./types.js";

export type ReadinessStatus =
    /** Every check passed. */
    | "ready"
    /** A check failed that the handover cannot get past. */
    | "blocked"
    /** The chain could not be read. Not a pass: shown as unknown, and never as ready. */
    | "unchecked"
    /** This build has no handover for the chain at all. */
    | "unsupported";

export interface ChainReadiness {
    chainId: string;
    status: ReadinessStatus;
    problems: readonly HandoverProblem[];
    /** Why the chain could not be read, when `status` is `unchecked`. */
    error?: string;
}

export interface ReadinessDeps {
    handoverFor(chainId: string): ChainHandover | null;
}

export async function checkHandovers(
    deps: ReadinessDeps,
    chains: readonly (HandoverAccount & { chainId: string })[],
): Promise<ChainReadiness[]> {
    return Promise.all(
        chains.map(async (chain): Promise<ChainReadiness> => {
            const handover = deps.handoverFor(chain.chainId);
            if (handover === null) return { chainId: chain.chainId, status: "unsupported", problems: [] };
            try {
                const problems = await handover.preflight({ chainRecord: chain });
                return {
                    chainId: chain.chainId,
                    status: problems.some((problem) => problem.blocking) ? "blocked" : "ready",
                    problems,
                };
            } catch (error) {
                return {
                    chainId: chain.chainId,
                    status: "unchecked",
                    problems: [],
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }),
    );
}

/**
 * Whether starting the ceremony can lead anywhere on-chain.
 *
 * An unreadable chain counts as possible: a node being down for a minute is not evidence the account
 * is unprotected, and refusing on it would block a recovery that might well succeed. It is shown as
 * unknown instead, never as ready.
 */
export function canHandOverAny(readiness: readonly ChainReadiness[]): boolean {
    return readiness.some((row) => row.status === "ready" || row.status === "unchecked");
}

/** One line per chain that will not be carried through, for a transcript or an error. */
export function describeBlocked(readiness: readonly ChainReadiness[]): string[] {
    return readiness.flatMap((row) => {
        if (row.status === "unsupported") return [`${row.chainId}: no on-chain handover in this build`];
        if (row.status !== "blocked") return [];
        const first = row.problems.find((problem) => problem.blocking);
        return [`${row.chainId}: ${first?.message ?? "refused"}`];
    });
}
