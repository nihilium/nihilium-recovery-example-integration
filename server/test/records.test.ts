/**
 * The record host over HTTP, as the app calls it.
 *
 * The app's sync reads before it appends and treats an unknown id as empty, so those are the
 * behaviours pinned here: reading needs nothing, appending needs the secret, and a record nobody
 * wrote looks exactly like an empty one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSealedDataStore } from "@nihilium/recovery-storage-local";
import { createRecordsRouter } from "../src/roles/records/index.js";

const SECRET = "test-append-secret";
const RECORD = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF";

let base = "";
let close: () => void = () => {};
let dir = "";

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "records-"));
    const app = express();
    app.use(express.json());
    app.use(
        "/api",
        createRecordsRouter({
            store: new LocalSealedDataStore({ directory: dir }),
            appendSecret: SECRET,
            log: () => {},
        }),
    );
    await new Promise<void>((resolve) => {
        const server = app.listen(0, () => {
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
            close = () => server.close();
            resolve();
        });
    });
});

afterAll(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
});

const entry = (entryId: string) => ({
    entryId,
    record: { format: "nihilium-vault-blob-v1", payload: { ciphertext: "00" } },
});

const append = (body: unknown, credential?: string) =>
    fetch(`${base}/records/${RECORD}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(credential === undefined ? {} : { "x-nihilium-append-credential": credential }),
        },
        body: JSON.stringify(body),
    });

describe("the record host", () => {
    it("reads an unknown record as empty, not as missing", async () => {
        const response = await fetch(`${base}/records/${RECORD}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ entries: [] });
    });

    it("refuses an append without the secret, and with the wrong one", async () => {
        expect((await append(entry("e1"))).status).toBe(403);
        expect((await append(entry("e1"), "wrong")).status).toBe(403);
    });

    it("appends with the secret, stamps the entry, and serves it back without one", async () => {
        expect((await append(entry("e1"), SECRET)).status).toBe(204);
        const { entries } = (await (await fetch(`${base}/records/${RECORD}`)).json()) as {
            entries: { entryId: string; storedAt?: number }[];
        };
        expect(entries.map((e) => e.entryId)).toEqual(["e1"]);
        expect(entries[0]!.storedAt).toBeTypeOf("number");
    });

    it("refuses to replace an entry — the store is add-only", async () => {
        expect((await append(entry("e1"), SECRET)).ok).toBe(false);
    });
});
