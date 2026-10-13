/**
 * What a reset keeps.
 *
 * The default reset is "I lost my seed". It must leave behind exactly what a recovery needs (the seal,
 * the records, the vault ledger and the vault's watch), so the demo recovers without a file. It must
 * also drop the handovers, which name destination seeds this browser is about to forget. The full
 * wipe must still leave nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset.js";
import { IdbHandoverStore, IdbSealStore } from "@nihilium/recovery-storage-indexeddb";
import { DEMO_DB_NAME } from "../src/demo/db.js";

function withStorage(): Map<string, string> {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
        localStorage: {
            get length() {
                return store.size;
            },
            key: (i: number) => [...store.keys()][i] ?? null,
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    };
    return store;
}

let local: Map<string, string>;

beforeEach(async () => {
    local = withStorage();
    local.set("nihilium-demo.seeds", "{}");
    local.set("nihilium-demo-watch:vault-1", "{}");
    // The app's own database, not a per-test one: reset acts on what the app uses.
    await new IdbSealStore({ dbName: DEMO_DB_NAME }).putSeal("vault-1", { format: "demo-seal", payload: {} } as never);
    await new IdbHandoverStore({ dbName: DEMO_DB_NAME }).put({ id: "vault-1:evm-sepolia", vaultId: "vault-1" } as never);
});

describe("resetting the wallet", () => {
    it("keeps the seal and the vault's watch, and forgets the seeds and handovers", async () => {
        await resetDemo({ keepRecovery: true });
        expect((await new IdbSealStore({ dbName: DEMO_DB_NAME }).listSeals()).map((ref) => ref.vaultId)).toEqual(["vault-1"]);
        expect(await new IdbHandoverStore({ dbName: DEMO_DB_NAME }).list()).toEqual([]);
        expect([...local.keys()]).toEqual(["nihilium-demo-watch:vault-1"]);
    });

    it("deletes everything when asked to", async () => {
        await resetDemo({ keepRecovery: false });
        expect(await new IdbSealStore({ dbName: DEMO_DB_NAME }).listSeals()).toEqual([]);
        expect(await new IdbHandoverStore({ dbName: DEMO_DB_NAME }).list()).toEqual([]);
        expect(local.size).toBe(0);
    });
});
