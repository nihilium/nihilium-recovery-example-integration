/**
 * The record host, from the wallet's side: push a vault's records and chain contexts to it, and pull
 * them back from it at recovery.
 *
 * The split this implements is the §12 one. The seal file is **bearer material plus instructions** —
 * the seal, the gate, and where the records live — and it is downloaded once. The records are
 * **inert ciphertext** and belong everywhere, so they are replicated to a host keyed by record id,
 * and every chain added later lands there too. A recovery on a fresh device then needs the file and
 * the host, and gets every chain the vault holds today rather than the ones it held on download day.
 *
 * **Chain context rides along, in the clear.** A decrypted record names its chain and account but
 * not its epoch, and nothing can be checked on-chain before a ceremony without the account and the
 * registered key. So each chain's context is stored next to the ciphertext as a plain JSON entry
 * tagged `CHAIN_CONTEXT_FORMAT`. The host therefore learns which accounts a vault protects; that is
 * a deliberate trade for being able to refuse a pointless ceremony, and it is this app's choice, not
 * something the SDK does.
 *
 * **To replace:** `appendCredential`, which a real wallet keeps per vault beside the seal rather than
 * as one app-wide secret. **Assumes:** this device is the origin and the host a replica — sync is
 * idempotent and safe to run any time, and a failed sync loses nothing local.
 */
import type { SealedDataEntry, SealedDataStore } from "@nihilium/recovery-core";
import { OneWayViolationError } from "@nihilium/recovery-core";
import type { VaultChainRecord, VaultRecord } from "./vaultRecords.js";

/** The format tag on a chain-context entry. Never passed to a condition adapter. */
export const CHAIN_CONTEXT_FORMAT = "nihilium-demo-chain-context-v1";

/** Header the service reads the append credential from. */
const APPEND_CREDENTIAL_HEADER = "x-nihilium-append-credential";

export interface RecordHost {
    /** The base URL, as recorded in a seal file. `GET|POST {url}/records/:id`. */
    readonly url: string;
    list(recordId: string): Promise<SealedDataEntry[]>;
    append(recordId: string, entry: SealedDataEntry): Promise<void>;
}

export interface RecordHostOptions {
    url: string;
    /** Only appends need it. `undefined` makes a read-only client, which is all a recovery needs. */
    appendCredential?: string;
    fetchFn?: typeof fetch;
}

export function createRecordHost(options: RecordHostOptions): RecordHost {
    const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    const base = options.url.replace(/\/+$/, "");
    const at = (recordId: string) => `${base}/records/${encodeURIComponent(recordId)}`;

    return {
        url: base,
        async list(recordId) {
            const response = await fetchFn(at(recordId));
            if (!response.ok) throw new Error(`Record host ${base} answered ${response.status}.`);
            const body = (await response.json()) as { entries?: SealedDataEntry[] };
            return body.entries ?? [];
        },
        async append(recordId, entry) {
            if (options.appendCredential === undefined) {
                throw new Error("This record host client was built without an append credential.");
            }
            const response = await fetchFn(at(recordId), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    [APPEND_CREDENTIAL_HEADER]: options.appendCredential,
                },
                body: JSON.stringify(entry),
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new Error(`Record host ${base} refused an append (${response.status}). ${detail}`.trim());
            }
        },
    };
}

/**
 * One chain's context as a host entry.
 *
 * The entry id is a hash of the content, so syncing the same context twice is a no-op and a changed
 * context (settled, re-keyed) is a new entry. Readers take the newest per chain.
 */
export async function chainContextEntry(chain: VaultChainRecord): Promise<SealedDataEntry> {
    const payload = JSON.stringify(chain);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    return {
        entryId: `ctx-${hex.slice(0, 32)}`,
        record: { format: CHAIN_CONTEXT_FORMAT, payload: chain },
    };
}

/** Ciphertext for the SDK, and the newest context per chain for this app. */
export function splitHostEntries(entries: readonly SealedDataEntry[]): {
    records: SealedDataEntry[];
    chains: VaultChainRecord[];
} {
    const records: SealedDataEntry[] = [];
    const latest = new Map<string, { chain: VaultChainRecord; storedAt: number; order: number }>();
    entries.forEach((entry, order) => {
        if (entry.record.format !== CHAIN_CONTEXT_FORMAT) {
            records.push(entry);
            return;
        }
        const chain = entry.record.payload as VaultChainRecord;
        const storedAt = entry.storedAt ?? 0;
        const seen = latest.get(chain.chainId);
        // Newest wins; the store's own append order breaks a tie within one second.
        if (seen === undefined || storedAt > seen.storedAt || (storedAt === seen.storedAt && order > seen.order)) {
            latest.set(chain.chainId, { chain, storedAt, order });
        }
    });
    return { records, chains: [...latest.values()].map((row) => row.chain) };
}

/**
 * Push everything this device holds for a vault that the host does not have yet.
 *
 * Reads the host first and appends only what is missing, so it can run on every load without
 * tripping the store's add-only rule, and a host that was down during a seal catches up next time.
 */
export async function syncVaultToHost(
    local: SealedDataStore,
    host: RecordHost,
    vault: VaultRecord,
): Promise<{ appended: number }> {
    const remote = new Set((await host.list(vault.recordId)).map((entry) => entry.entryId));
    const pending: SealedDataEntry[] = [
        ...(await local.getEntries(vault.recordId)),
        ...(await Promise.all(vault.chains.map(chainContextEntry))),
    ].filter((entry) => !remote.has(entry.entryId));

    for (const entry of pending) {
        // `storedAt` is the host's to set.
        const { storedAt: _local, ...outgoing } = entry;
        await host.append(vault.recordId, outgoing);
    }
    return { appended: pending.length };
}

/**
 * Bring the host's view of a vault into this device: its records into the local store, and its
 * chain contexts into the vault record.
 *
 * A chain the host knows and the vault record does not is added — that is a chain protected after
 * the seal file was saved. A chain both know takes the **newer** row: a re-key writes a fresh
 * `addedAt` and a new recovery key, and a seal file's copy from before it would check the chain
 * against a key it no longer holds. On a tie, the row that records a settlement wins; otherwise the
 * local one stays.
 */
export async function pullVaultFromHost(
    local: SealedDataStore,
    host: RecordHost,
    vault: VaultRecord,
): Promise<{ vault: VaultRecord; recordsAdded: number; chainsAdded: string[] }> {
    const { records, chains } = splitHostEntries(await host.list(vault.recordId));

    let recordsAdded = 0;
    for (const entry of records) {
        try {
            await local.addEntry(vault.recordId, entry);
            recordsAdded += 1;
        } catch (error) {
            // Already here: an add-only store says so by refusing, which for a pull is success.
            if (!(error instanceof OneWayViolationError)) throw error;
        }
    }

    const known = new Set(vault.chains.map((chain) => chain.chainId));
    const added = chains.filter((chain) => !known.has(chain.chainId));
    const merged = vault.chains.map((mine) => {
        const theirs = chains.find((chain) => chain.chainId === mine.chainId);
        return theirs === undefined ? mine : newerOf(mine, theirs);
    });
    const changed = added.length > 0 || merged.some((row, i) => row !== vault.chains[i]);
    return {
        vault: changed ? { ...vault, chains: [...merged, ...added] } : vault,
        recordsAdded,
        chainsAdded: added.map((chain) => chain.chainId),
    };
}

function newerOf(mine: VaultChainRecord, theirs: VaultChainRecord): VaultChainRecord {
    if (theirs.addedAt !== mine.addedAt) return theirs.addedAt > mine.addedAt ? theirs : mine;
    return mine.settlement === null && theirs.settlement !== null ? theirs : mine;
}

/** The host a vault names, or the app's own when it names none. */
export function recordHostUrlFor(vault: Pick<VaultRecord, "recordHosts">, fallback: string): string {
    return vault.recordHosts?.[0] ?? fallback;
}
