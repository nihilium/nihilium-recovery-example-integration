/**
 * Watching a vault: which targets a registration carries, when it is replaced, and what it renders.
 *
 * The rule that matters most is the last one. A watchtower that cannot vouch for its answer — never
 * polled, degraded, unreachable — must render as `unknown`, never as watching. A green mark over an
 * unwatched vault is exactly the misreading this role exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { EvmKeyAdapter } from "@nihilium/recovery-key-evm";
import { WatchtowerUnreachableError, type ConditionAdapter, type WatchStatus } from "@nihilium/recovery-core";
import {
    buildVaultWatch,
    syncVaultWatch,
    targetIdsOf,
    watchView,
    type ChainWatchInput,
    type WatchRecord,
} from "../src/integration/recovery/watch.js";
import type { OnChainState } from "../src/integration/recovery/settlement/protect.js";
import type { RecoveryMethod } from "../src/integration/conditions/types.js";
import type { VaultChainRecord, VaultRecord } from "../src/integration/recovery/vaultRecords.js";
import { IdbSealedDataStore } from "../src/integration/storage/dataStore.js";
import { IdbSealStore } from "../src/integration/storage/sealStore.js";

const OFF_CHAIN = { kind: "nihilium-reveal", targetId: "reveal-1", params: {}, label: "cohort" };

const METHOD = {
    appendAdapter: () => ({ watchTargets: () => [OFF_CHAIN] }) as unknown as ConditionAdapter,
} as unknown as RecoveryMethod;

const VAULT = {
    vaultId: "vault-w",
    publicComponent: { format: "demo" },
    gate: { methodId: "email-quorum" },
} as unknown as VaultRecord;

function onchain(over: Partial<OnChainState> = {}): OnChainState {
    return {
        installed: true,
        recoveryOwner: "0x1111111111111111111111111111111111111111",
        matchesVault: true,
        attempt: null,
        clock: null,
        intentHash: null,
        epoch: 0,
        configNonce: 1,
        ...over,
    };
}

function chain(chainId: string, state: OnChainState | null, extra: Partial<ChainWatchInput> = {}): ChainWatchInput {
    const namespace = chainId === "evm-sepolia" ? "eip155:11155111" : chainId === "arbitrum-sepolia" ? "eip155:421614" : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    return {
        record: { chainId, namespace, accountId: "0x7777777777777777777777777777777777777777" } as VaultChainRecord,
        label: chainId,
        onchain: state,
        ...extra,
    };
}

function plan(chains: ChainWatchInput[]) {
    const db = `watch-${crypto.randomUUID()}`;
    return buildVaultWatch({
        vault: VAULT,
        method: METHOD,
        keyAdapter: new EvmKeyAdapter(),
        stores: { sealStore: new IdbSealStore({ dbName: db }), dataStore: new IdbSealedDataStore({ dbName: db }) },
        chains,
    });
}

describe("what a vault's watch covers", () => {
    it("always carries the off-chain plane, which fires during the ceremony", () => {
        const { registration } = plan([]);
        expect(registration.targets.map((t) => t.kind)).toEqual(["nihilium-reveal"]);
    });

    it("adds an on-chain target only for a chain protected by this vault", () => {
        const { registration, unwatched } = plan([
            chain("evm-sepolia", onchain()),
            chain("evm-sepolia-2", onchain()),
        ]);
        expect(registration.targets.map((t) => t.kind)).toEqual(["nihilium-reveal", "evm-recovery-module"]);
        // Protected by some other vault's key is not protected by this one.
        const stale = plan([chain("evm-sepolia", onchain({ matchesVault: false }))]);
        expect(stale.registration.targets).toHaveLength(1);
        expect(stale.unwatched[0]!.reason).toBe("not protected yet");
        expect(unwatched.map((row) => row.chainId)).toEqual(["evm-sepolia-2"]);
    });

    it("watches Solana with the vault PDA and the registration nonce", () => {
        const { registration } = plan([
            chain("solana-devnet", onchain({ recoveryOwner: "So11111111111111111111111111111111111111112" }), {
                solana: { vault: "Dwv8gSxkNa8ZYYFLy2hJHKW9652TtGrUM8DunN5Mrwy8", programId: "Prog1111111111111111111111111111111111111111" },
            }),
        ]);
        const target = registration.targets.find((t) => t.kind === "solana-recovery-vault")!;
        expect(target.params).toMatchObject({ expectedConfigNonce: 1, expectedEpoch: 0 });
    });

    it("names Arbitrum as unwatched on-chain rather than dropping it", () => {
        const { registration, unwatched } = plan([chain("arbitrum-sepolia", onchain())]);
        expect(registration.targets).toHaveLength(1);
        expect(unwatched).toEqual([
            { chainId: "arbitrum-sepolia", label: "arbitrum-sepolia", reason: "not watched on-chain" },
        ]);
    });

    it("flags an unreadable chain, so the current watch is kept rather than shrunk", () => {
        expect(plan([chain("evm-sepolia", null)]).incomplete).toBe(true);
        expect(plan([chain("evm-sepolia", onchain())]).incomplete).toBe(false);
    });
});

describe("keeping the registration in step", () => {
    function client() {
        const calls: string[] = [];
        let n = 0;
        return {
            calls,
            register: async () => {
                calls.push("register");
                n += 1;
                return { watchId: `w${n}`, manageCredential: `m${n}` };
            },
            unregister: async (id: string, manage: string) => {
                calls.push(`unregister ${id} ${manage}`);
            },
        };
    }
    const registration = plan([]).registration;

    it("registers once, and does nothing while the targets are the same", async () => {
        const c = client();
        const first = await syncVaultWatch({ client: c as never, url: "u", credential: "s", current: undefined, registration });
        expect(first.changed).toBe(true);
        const again = await syncVaultWatch({ client: c as never, url: "u", credential: "s", current: first.record, registration });
        expect(again.changed).toBe(false);
        expect(c.calls).toEqual(["register"]);
    });

    it("replaces the watch when a chain is added, and unregisters the old one after", async () => {
        const c = client();
        const current: WatchRecord = {
            url: "u",
            watchId: "old",
            manageCredential: "old-m",
            targetIds: targetIdsOf(registration),
            registeredAt: 1,
        };
        const grown = plan([chain("evm-sepolia", onchain())]).registration;
        const next = await syncVaultWatch({ client: c as never, url: "u", credential: "s", current, registration: grown });
        expect(next.changed).toBe(true);
        expect(next.record.targetIds).toHaveLength(2);
        // Register first: in between there are two watches, never none.
        expect(c.calls).toEqual(["register", "unregister old old-m"]);
    });
});

describe("what the card shows", () => {
    const status = (
        over: Omit<Partial<WatchStatus>, "health"> & { health?: Partial<WatchStatus["health"]> },
    ): WatchStatus =>
        ({
            watchId: "w",
            alarm: "none",
            protection: "intact",
            targets: [],
            warnings: [],
            summary: "Nothing has happened.",
            ...over,
            health: { state: "watching", expectedPollIntervalSeconds: 15, unanswered: [], ...over.health },
        }) as WatchStatus;

    it("is watching only when healthy with no alarm", () => {
        expect(watchView({ status: status({}) }).state).toBe("watching");
    });

    it("never renders never-polled, degraded, suspended or unknown as watching", () => {
        for (const state of ["never-polled", "degraded", "suspended"] as const) {
            expect(watchView({ status: status({ health: { state } }) }).state).toBe("unknown");
        }
        expect(watchView({ status: status({ alarm: "unknown" }) }).state).toBe("unknown");
    });

    it("reads an unreachable watchtower as unknown, not as off", () => {
        expect(watchView({ error: new WatchtowerUnreachableError("connection refused") }).state).toBe("unknown");
    });

    it("raises the alarm, and says whether it is on-chain yet", () => {
        const offChain = watchView({
            status: status({
                alarm: "attempt-detected",
                targets: [{ targetId: "r", label: "c", kind: "nihilium-reveal", verdict: "tripped" }],
            }),
        });
        expect(offChain).toMatchObject({ state: "alarm", onchain: false });

        const onChain = watchView({
            status: status({
                alarm: "attempt-detected",
                actBefore: 1_900_000_000,
                targets: [{ targetId: "e", label: "e", kind: "evm-recovery-module", verdict: "tripped" }],
            }),
        });
        expect(onChain).toMatchObject({ state: "alarm", onchain: true, actBefore: 1_900_000_000 });
    });
});
