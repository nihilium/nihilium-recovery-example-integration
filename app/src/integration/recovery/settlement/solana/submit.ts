/**
 * Who pays, decided at the call site instead of baked into every instruction.
 *
 * Anchor's `.rpc()` signs *and* sends with the provider's wallet, which makes the owner the fee
 * payer by construction. That is fine until the owner has no SOL — and on this chain that is the
 * ordinary case, not an edge one: a fresh wallet holds nothing, and `create_vault` needs rent
 * before it can hold anything.
 *
 * **Solana needs no paymaster for this.** The fee payer is simply a designated signer, so the server
 * paying is a co-sign rather than a contract: the owner signs what they are authorising, the
 * relayer signs for the cost. The program already separates `payer` from `creator` for exactly this
 * reason, and rent — which has no EVM equivalent — comes from the payer too.
 *
 * `"self"` is kept beside it rather than replaced, so the demo still works with the server down.
 * A wallet that only functions when someone else is paying has hidden the thing worth seeing.
 *
 * **To replace:** `feePayerRoute`, if your relayer lives elsewhere. **Assumes:** the server co-signs
 * only what its allowlist accepts — it refuses any transaction touching a program it did not
 * expect, so this is not a way to have someone else pay for arbitrary work.
 */
import type { Connection, Keypair, Transaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

/** The subset of Anchor's methods builder this needs. Structural, so no Anchor types leak in. */
export interface Submittable {
    rpc(): Promise<string>;
    transaction(): Promise<Transaction>;
}

export type Submitter =
    /** The owner pays, out of its own lamports. Anchor's ordinary path. */
    | { kind: "self" }
    /**
     * The server pays. The owner still signs everything it is authorising.
     *
     * `relayer` is carried rather than looked up per call, because `create_vault` takes the payer
     * as an **account** and not only as the transaction's fee payer. An account list that disagreed
     * with the fee payer would fail inside the program, where the error names a constraint rather
     * than the mistake.
     */
    | { kind: "feePayer"; serverUrl: string; relayer: string };

interface RelayerConfig {
    relayer: string;
    programId: string;
    cluster: string;
}

function feePayerRoute(serverUrl: string): string {
    return `${serverUrl}/api/roles/relayer/solana`;
}

/**
 * Ask the server whether it will pay, and who it pays as.
 *
 * Returns `null` rather than throwing when the route is absent: a server started without
 * `SOLANA_RPC_URL` does not mount it, and "nobody is paying for you" is a state the caller should
 * fall back from, not an error.
 */
export async function loadFeePayer(serverUrl: string): Promise<Submitter | null> {
    try {
        const config = await fetchConfig(feePayerRoute(serverUrl));
        return { kind: "feePayer", serverUrl, relayer: config.relayer };
    } catch {
        return null;
    }
}

/**
 * Send `builder`'s transaction, paid by whoever `via` names.
 *
 * `owner` signs in both cases. The difference is only who is on the hook for the fee and the rent,
 * which is the point: a co-signed transaction authorises exactly what a self-paid one would.
 */
export async function submit(
    params: {
        connection: Connection;
        owner: Keypair;
        builder: Submittable;
        via: Submitter;
        onProgress?: (message: string) => void;
    },
): Promise<string> {
    if (params.via.kind === "self") {
        try {
            return await params.builder.rpc();
        } catch (error) {
            // web3.js puts the program's own words behind `getLogs()` and its message literally
            // tells you to call it. Not doing so is how "Logs: []" reaches a user.
            throw await withSolanaLogs(error);
        }
    }

    const route = feePayerRoute(params.via.serverUrl);
    params.onProgress?.(`feepayer      relayer=${params.via.relayer} — the owner pays nothing`);

    const tx = await params.builder.transaction();
    tx.feePayer = new PublicKey(params.via.relayer);
    // Fetched after the transaction is built, so the window the server checks against is as wide as
    // possible. A blockhash older than the build is refused rather than silently retried.
    tx.recentBlockhash = (await params.connection.getLatestBlockhash("confirmed")).blockhash;
    // `partialSign`, never `sign`: the relayer's slot must be left empty, and `sign` would demand
    // every signature be present.
    tx.partialSign(params.owner);

    const response = await fetch(`${route}/feepayer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
        }),
    });

    const body = (await response.json()) as { hash?: string; error?: string };
    if (!response.ok || body.hash === undefined) {
        // The server names which of its rules refused. Passing that through is the difference
        // between "the relayer declined" and knowing why.
        throw new Error(body.error ?? `The fee payer refused with HTTP ${response.status}.`);
    }

    params.onProgress?.(`feepayer      tx=${body.hash}`);
    return body.hash;
}

/**
 * Re-throw with the program's logs attached.
 *
 * `SendTransactionError` carries `Logs: []` in its message and the real ones behind an async
 * `getLogs()`, so the default rendering is an error that tells the reader to go and fetch the
 * explanation themselves.
 */
async function withSolanaLogs(error: unknown): Promise<Error> {
    const base = error instanceof Error ? error : new Error(String(error));
    const getLogs = (error as { getLogs?: unknown }).getLogs;
    if (typeof getLogs !== "function") return base;
    try {
        const logs = (await getLogs.call(error)) as string[] | null;
        const interesting = (logs ?? []).filter((line) =>
            /AnchorError|Error Message|Instruction: |insufficient|debit/i.test(line),
        );
        if (interesting.length === 0) return base;
        return new Error(`${base.message} — ${interesting.slice(-4).join(" | ")}`);
    } catch {
        return base;
    }
}

async function fetchConfig(route: string): Promise<RelayerConfig> {
    const response = await fetch(`${route}/config`);
    if (!response.ok) {
        // A 404 here is the honest answer when the server runs without `SOLANA_RPC_URL`: the routes
        // are not mounted rather than stubbed, so this says so instead of reporting a send failure.
        throw new Error(
            "The Solana relayer is not reachable, so nothing can be paid for on your behalf. " +
                "Start the server with `npm run dev:server`, and check SOLANA_RPC_URL is set.",
        );
    }
    return (await response.json()) as RelayerConfig;
}
