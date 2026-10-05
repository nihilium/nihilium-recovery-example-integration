/**
 * The watchtower over HTTP, with a real service and store and a fake probe.
 *
 * What is pinned is the "broken is not quiet" half as this server exposes it: a fresh watch reads
 * `unknown`, never clear; registering needs the operator's secret; there is no listing; and the
 * demo's forced poll exists only when enabled. The probe is fake so the alarm can be tripped on cue.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalWatchStore } from "@nihilium/recovery-storage-local";
import type { WatchObservation, WatchProbe, WatchTarget } from "@nihilium/recovery-core";
import { createWatchtower, WATCH_CREDENTIAL_HEADER } from "../src/roles/watchtower/index.js";

const SECRET = "test-watch-secret";
const TARGET: WatchTarget = { kind: "fake", targetId: "0123456789abcdef", params: {}, label: "fake target" };

let tripped = false;
const probe: WatchProbe = {
    kind: "fake",
    async probe(targets) {
        return targets.map(
            (target): WatchObservation => ({
                targetId: target.targetId,
                verdict: tripped ? "tripped" : "clear",
                detail: tripped ? "fake attempt" : "nothing",
                ...(tripped ? { signal: "fake:tripped", evidenceAt: 1 } : {}),
            }),
        );
    },
};

let dir = "";
const servers: { base: string; close: () => void }[] = [];

async function serve(allowForcedPoll: boolean): Promise<string> {
    const watchtower = createWatchtower({
        store: new LocalWatchStore({ directory: dir }),
        probes: [probe],
        registerSecret: SECRET,
        pollIntervalSeconds: 15,
        allowForcedPoll,
        log: () => {},
    });
    const app = express();
    app.use(express.json());
    app.use("/api/watchtower", watchtower.router);
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/watchtower`;
            servers.push({ base, close: () => server.close() });
            resolve(base);
        });
    });
}

let base = "";
beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "watches-"));
    base = await serve(true);
});

afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
});

const register = (credential?: string) =>
    fetch(`${base}/watches`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(credential === undefined ? {} : { [WATCH_CREDENTIAL_HEADER]: credential }),
        },
        body: JSON.stringify({ targets: [TARGET] }),
    });

describe("the watchtower", () => {
    it("refuses a registration without the operator's secret, or with the wrong one", async () => {
        expect((await register()).status).toBe(403);
        expect((await register("wrong")).status).toBe(403);
    });

    it("has no listing", async () => {
        expect((await fetch(`${base}/watches`)).status).toBe(404);
    });

    it("reads a fresh watch as unknown, then clear, then raises the alarm", async () => {
        const response = await register(SECRET);
        expect(response.status).toBe(201);
        const { watchId } = (await response.json()) as { watchId: string };
        const status = async () =>
            ((await (await fetch(`${base}/watches/${watchId}`)).json()) as { status: { alarm: string; health: { state: string } } }).status;

        // Nothing has looked yet, and that must not read as safe.
        expect(await status()).toMatchObject({ alarm: "unknown", health: { state: "never-polled" } });

        expect((await fetch(`${base}/poll`, { method: "POST" })).status).toBe(200);
        expect(await status()).toMatchObject({ alarm: "none", health: { state: "watching" } });

        // The next cycle sees the attempt. A forced poll re-probes only what is due, so the target
        // is re-registered under a fresh watch rather than waiting out the interval.
        tripped = true;
        const fresh = (await (await register(SECRET)).json()) as { watchId: string };
        await fetch(`${base}/poll`, { method: "POST" });
        const alarmed = (await (await fetch(`${base}/watches/${fresh.watchId}`)).json()) as {
            status: { alarm: string };
        };
        expect(alarmed.status.alarm).toBe("attempt-detected");
    });

    it("has no poll route unless the demo affordance is on", async () => {
        const closed = await serve(false);
        expect((await fetch(`${closed}/poll`, { method: "POST" })).status).toBe(404);
    });
});
