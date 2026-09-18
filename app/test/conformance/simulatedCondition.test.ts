/**
 * The stand-in adapter, driven through the **real** `QuorumConditionAdapter` and the **real**
 * `RecoverySDK` — so what is being tested is the wiring an integrator would write, not a mock of it.
 *
 * The app itself runs the live ceremony; this suite runs the same code paths against a local
 * adapter, because a test that bought a seal per run is a test nobody runs.
 *
 * Also runs the SDK's `sealPublicComponentConformance`, which is what forces `publicComponentOf` to
 * be a whitelist: it serializes the whole projection and scans it for declared secrets at any depth.
 */
import { RecoverySDK, mintRecordId, withCapability } from "@nihilium/recovery-core";
import { sealPublicComponentConformance } from "@nihilium/recovery-core/testing";
import { QuorumConditionAdapter, QuorumIncompleteError } from "@nihilium/recovery-condition-quorum";
import { EvmKeyAdapter } from "@nihilium/recovery-key-evm";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { createDemoCohort } from "../../src/integration/conditions/simulated/cohort.js";
import { DemoEmailConditionAdapter } from "../../src/integration/conditions/simulated/demoEmailCondition.js";
import { IdbSealedDataStore } from "../../src/integration/storage/dataStore.js";
import { IdbSealStore } from "../../src/integration/storage/sealStore.js";

const EMAILS = ["alice@gmail.com", "bob@fastmail.com", "carol@proton.me"];

const chain = {
    namespace: "eip155:11155111",
    tier: "smart-account" as const,
    accountId: "0xCfC4Bd2E5e1B1E2A6F9E1C8a4c5B0f7D8e9A5838",
    vaultId: "vault-under-test",
    epoch: 0,
};

async function sealTwoOfThree(dbName: string) {
    const cohort = createDemoCohort();
    const quorum = new QuorumConditionAdapter({
        members: EMAILS.map((_, i) => cohort.adapterFor(i + 1)),
    });
    const sdk = new RecoverySDK({
        key: new EvmKeyAdapter(),
        condition: quorum,
        sealStore: new IdbSealStore({ dbName }),
        dataStore: new IdbSealedDataStore({ dbName }),
    });
    const condition = await quorum.buildCondition({
        threshold: 2,
        members: EMAILS.map((email) => ({ email })),
    });
    // Two calls since the SDK split them: `createVault()` is the paid ceremony and yields an empty
    // vault, `addChain()` puts this chain in it. The counters below assert against the first.
    const created = await sdk.createVault({ condition, vaultId: chain.vaultId });
    const added = await sdk.addChain({ publicComponent: created.publicComponent, chain });
    return { cohort, quorum, sdk, sealed: { ...created, ...added } };
}

describe("a 2-of-3 simulated email quorum", () => {
    it("seals once per guardian and recovers with any two", async () => {
        const dbName = `quorum-${crypto.randomUUID()}`;
        const { cohort, quorum, sdk, sealed } = await sealTwoOfThree(dbName);

        expect(cohort.stats().map((m) => m.stats.ceremonies)).toEqual([1, 1, 1]);

        const proof = await quorum.buildProof({
            members: [{ index: 1, params: {} }, { index: 3, params: {} }],
        });
        const { authority, spent } = await sdk.recover({ proof, chain });

        // The lesson, as a number rather than a claim: guardian #2 was never contacted.
        expect(cohort.stats().map((m) => m.stats.recoveries)).toEqual([1, 0, 1]);

        expect(authority.kind).toBe("capability");
        if (authority.kind !== "capability") throw new Error("expected a capability");
        await withCapability(authority.capability, async (capability) => {
            expect(bytesToHex(capability.publicKey.bytes)).toBe(bytesToHex(sealed.recoveryPubKey.bytes));
            const signature = await capability.sign(new Uint8Array(32).fill(1));
            expect(signature.bytes).toHaveLength(65);
        });
        expect(authority.capability.zeroized).toBe(true);

        // Not optional to handle: getting here opened every record in the vault.
        expect(spent.vaultId).toBe(chain.vaultId);
        expect(spent.reason).toMatch(/root secret/i);
    });

    it("names every member's outcome when one cannot answer", async () => {
        const dbName = `quorum-${crypto.randomUUID()}`;
        const { cohort, quorum, sdk } = await sealTwoOfThree(dbName);
        cohort.setReachable(3, false);

        const proof = await quorum.buildProof({
            members: [{ index: 1, params: {} }, { index: 3, params: {} }],
        });
        await expect(sdk.recover({ proof, chain })).rejects.toThrow(QuorumIncompleteError);
    });

    it("refuses a count that is not exactly the threshold", async () => {
        const dbName = `quorum-${crypto.randomUUID()}`;
        const { quorum, sdk } = await sealTwoOfThree(dbName);
        const proof = await quorum.buildProof({ members: [{ index: 1, params: {} }] });
        // Fewer cannot reconstruct; more would drag a guardian through a ceremony nobody needs.
        await expect(sdk.recover({ proof, chain })).rejects.toThrow();
    });

    it("waits for a human where a live ceremony would", async () => {
        const dbName = `quorum-${crypto.randomUUID()}`;
        const waited: number[] = [];
        const cohort = createDemoCohort({
            onHumanStep: async (index) => {
                waited.push(index);
            },
        });
        const quorum = new QuorumConditionAdapter({
            members: EMAILS.map((_, i) => cohort.adapterFor(i + 1)),
        });
        const sdk = new RecoverySDK({
            key: new EvmKeyAdapter(),
            condition: quorum,
            sealStore: new IdbSealStore({ dbName }),
            dataStore: new IdbSealedDataStore({ dbName }),
        });
        const condition = await quorum.buildCondition({
            threshold: 2,
            members: EMAILS.map((email) => ({ email })),
        });
        const created = await sdk.createVault({ condition, vaultId: chain.vaultId });
        await sdk.addChain({ publicComponent: created.publicComponent, chain });

        await sdk.recover({
            proof: await quorum.buildProof({ members: [{ index: 2, params: {} }, { index: 3, params: {} }] }),
            chain,
        });
        expect(waited.sort()).toEqual([2, 3]);
    });
});

describe("DemoEmailConditionAdapter — public component conformance", () => {
    for (const testCase of sealPublicComponentConformance) {
        it(testCase.name, async () => {
            await testCase.run(async () => {
                const adapter = new DemoEmailConditionAdapter();
                const condition = await adapter.buildCondition({ email: "alice@gmail.com" });
                const { seal, publicComponent } = await adapter.sealVault({
                    condition,
                    recordId: mintRecordId(),
                });
                return {
                    seal,
                    publicComponent,
                    // What must appear nowhere in the projection, at any depth.
                    secrets: [
                        "alice@gmail.com",
                        (seal.payload as { vaultPrivHex: string }).vaultPrivHex,
                    ],
                };
            });
        });
    }
});
