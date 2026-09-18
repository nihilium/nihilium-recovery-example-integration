/**
 * The SDK's own storage conformance suites, run against this app's IndexedDB implementations.
 *
 * These are not tests this repo wrote: `@nihilium/recovery-core/testing` exports them as plain
 * `{name, run(create)}` case objects precisely so an implementation written outside the SDK runs the
 * same cases rather than its own paraphrase of them. If one fails, the store is wrong — not the test.
 */
import { sealedDataStoreConformance, sealStoreConformance } from "@nihilium/recovery-core/testing";
import { describe, expect, it } from "vitest";
import { IdbSealedDataStore } from "../../src/integration/storage/dataStore.js";
import { IdbSealStore } from "../../src/integration/storage/sealStore.js";

/**
 * One database name per case, hoisted out of the factory.
 *
 * `run()` calls `create()` more than once — the "survives a reopen" cases build a second store and
 * expect the first one's data to be there. A name minted inside the factory would give each call its
 * own empty database, and those cases would pass while proving nothing.
 */
function dbName(): string {
    return `conformance-${crypto.randomUUID()}`;
}

describe("IdbSealStore — §12 conformance", () => {
    for (const testCase of sealStoreConformance) {
        it(testCase.name, async () => {
            const name = dbName();
            await testCase.run(() => new IdbSealStore({ dbName: name }));
        });
    }
});

describe("IdbSealedDataStore — one-way vault conformance", () => {
    for (const testCase of sealedDataStoreConformance) {
        it(testCase.name, async () => {
            const name = dbName();
            await testCase.run(() => new IdbSealedDataStore({ dbName: name }));
        });
    }
});

describe("the suites themselves", () => {
    it("are not empty", () => {
        // A conformance run over zero cases is a green tick that means nothing.
        expect(sealStoreConformance.length).toBeGreaterThan(0);
        expect(sealedDataStoreConformance.length).toBeGreaterThan(0);
    });
});
