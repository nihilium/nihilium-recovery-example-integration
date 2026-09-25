/**
 * The record host, from the wallet's side — and the failure it exists to prevent.
 *
 * A seal file used to carry the records, frozen on the day it was downloaded. A Solana account
 * protected afterwards was on the device and on nothing else, so a reset followed by an import
 * recovered a vault that did not know Solana existed. The file now carries the seal and where the
 * records live; the records and every chain's context are pushed to the host as the vault grows, and
 * pulled back from it on import. This drives that whole sequence against a host kept in its own
 * store, standing in for `server/src/roles/records`.
 */
import { describe, expect, it } from "vitest";
import { EvmKeyAdapter } from "@nihilium/recovery-key-evm";
import { SolanaKeyAdapter, SOLANA_NAMESPACE } from "@nihilium/recovery-key-solana";
import type { ConditionAdapter, SealedDataEntry } from "@nihilium/recovery-core";
import { createDemoCohort } from "../src/integration/conditions/simulated/cohort.js";
import { createEmailQuorumMethod } from "../src/integration/conditions/emailQuorum.js";
import { createEmailSubjectKind } from "../src/integration/conditions/subjects/email.js";
import {
    addChainToVault,
    exportSealFile,
    importSealFile,
    refreshVaultFromHost,
    sealVault,
} from "../src/integration/recovery/vault.js";
import {
    CHAIN_CONTEXT_FORMAT,
    splitHostEntries,
    syncVaultToHost,
    type RecordHost,
} from "../src/integration/recovery/recordHost.js";
import { parseSealFile } from "../src/integration/recovery/sealFile.js";
import { VaultRecordStore, type VaultChainRecord } from "../src/integration/recovery/vaultRecords.js";
import { IdbSealedDataStore } from "../src/integration/storage/dataStore.js";
import { IdbSealStore } from "../src/integration/storage/sealStore.js";
import type { ChainModule, DerivedAccount } from "../src/integration/chains/types.js";

const HOST_URL = "https://records.example/api";

function stubChain(over: Partial<ChainModule> & Pick<ChainModule, "id" | "namespace">): ChainModule {
    return {
        label: over.id,
        icon: "ethereum",
        tier: "smart-account",
        keyAdapter: new EvmKeyAdapter(),
        deriveAccounts: async () => [],
        formatAddress: (a) => a,
        explorerUrl: () => null,
        balanceOf: async () => ({ raw: 0n, decimals: 18, symbol: "ETH", source: "chain" }),
        settlement: null,
        ...over,
    } as ChainModule;
}

const EVM = stubChain({ id: "evm-sepolia", namespace: "eip155:11155111" });
const SOLANA = stubChain({
    id: "solana-devnet",
    namespace: SOLANA_NAMESPACE.devnet,
    keyAdapter: new SolanaKeyAdapter(),
});

function account(accountId: string): DerivedAccount {
    return {
        accountId,
        address: accountId,
        label: "a",
        derivationPath: "m",
        index: 0,
        signer: { address: `signer-of-${accountId}` },
    } as DerivedAccount;
}

/** A host with the service's semantics: add-only, `storedAt` set on write, unknown ids read empty. */
function memoryHost(): RecordHost & { appends: number } {
    const store = new IdbSealedDataStore({ dbName: `host-${crypto.randomUUID()}` });
    let clock = 1_000;
    const host = {
        url: HOST_URL,
        appends: 0,
        list: (recordId: string) => store.getEntries(recordId as never),
        async append(recordId: string, entry: SealedDataEntry) {
            host.appends += 1;
            await store.addEntry(recordId as never, { ...entry, storedAt: (clock += 1) });
        },
    };
    return host;
}

function device() {
    const dbName = `device-${crypto.randomUUID()}`;
    return {
        sealStore: new IdbSealStore({ dbName }),
        dataStore: new IdbSealedDataStore({ dbName }),
        vaults: new VaultRecordStore({ dbName }),
    };
}

function method() {
    const cohort = createDemoCohort();
    return createEmailQuorumMethod({
        mode: "simulated",
        paid: false,
        kind: createEmailSubjectKind({
            adapterFor: (_subject, index): ConditionAdapter => cohort.adapterFor(index),
        }),
    });
}

function subjectsFor(m: ReturnType<typeof method>) {
    return ["alice@gmail.com", "bob@proton.me", "carol@outlook.com"].map(
        (email) => (m.kinds[0]!.parse({ kindId: "email", values: { email } }) as { subject: unknown }).subject,
    ) as Parameters<typeof sealVault>[1]["subjects"];
}

describe("a seal file downloaded before a chain was added", () => {
    it("recovers that chain after a reset, from the record host", async () => {
        const m = method();
        const host = memoryHost();
        const original = device();

        // Seal on EVM, replicate, and save the file — the one moment a user is asked to.
        const { vault } = await sealVault(original, {
            method: m,
            subjects: subjectsFor(m),
            threshold: 2,
            chain: EVM,
            account: account("0xCfC4C807Ed404ae1a65fbe0EdaA09EF002E75838"),
            vaultId: "vault-grows",
            walletId: "wallet",
            recordHosts: [HOST_URL],
        });
        await syncVaultToHost(original.dataStore, host, vault);
        const file = parseSealFile(JSON.stringify(await exportSealFile(original, "vault-grows")));
        expect(file.chains.map((c) => c.chainId)).toEqual(["evm-sepolia"]);
        expect(file.entries).toBeUndefined();

        // Later: Solana is protected, and replicated like everything else.
        const grown = await addChainToVault(original, {
            method: m,
            vault,
            chain: SOLANA,
            account: account("So11111111111111111111111111111111111111112"),
        });
        await syncVaultToHost(original.dataStore, host, grown);

        // A reset: nothing on this device survives but the file saved before Solana existed.
        const fresh = device();
        const imported = await importSealFile(fresh, file);
        expect(imported.vault.chains.map((c) => c.chainId)).toEqual(["evm-sepolia"]);

        const pulled = await refreshVaultFromHost(fresh, host, imported.vault);
        expect(pulled.chainsAdded).toEqual(["solana-devnet"]);
        expect(pulled.vault.chains.map((c) => c.chainId)).toEqual(["evm-sepolia", "solana-devnet"]);
        expect(pulled.recordsAdded).toBe(2);
        // Saved, so the recovery that follows reads the grown vault, not the file's.
        expect((await fresh.vaults.get("vault-grows"))?.chains).toHaveLength(2);
        // The records the SDK will be handed — ciphertext only, never a context entry.
        const local = await fresh.dataStore.getEntries(vault.recordId);
        expect(local.map((e) => e.record.format)).not.toContain(CHAIN_CONTEXT_FORMAT);
        expect(local).toHaveLength(2);
    });
});

describe("syncing to the host", () => {
    it("appends only what the host lacks, so it can run on every load", async () => {
        const m = method();
        const host = memoryHost();
        const origin = device();
        const { vault } = await sealVault(origin, {
            method: m,
            subjects: subjectsFor(m),
            threshold: 2,
            chain: EVM,
            account: account("0xCfC4C807Ed404ae1a65fbe0EdaA09EF002E75838"),
            vaultId: "vault-sync",
            walletId: "wallet",
        });

        // One record and one chain context.
        expect((await syncVaultToHost(origin.dataStore, host, vault)).appended).toBe(2);
        expect((await syncVaultToHost(origin.dataStore, host, vault)).appended).toBe(0);
        expect(host.appends).toBe(2);
    });
});

describe("reading chain contexts off the host", () => {
    const row = (addedAt: number, key: string) =>
        ({ chainId: "solana-devnet", addedAt, recoveryPubKeyHex: key, settlement: null }) as VaultChainRecord;
    const context = (chain: VaultChainRecord, storedAt: number): SealedDataEntry => ({
        entryId: `ctx-${storedAt}`,
        storedAt,
        record: { format: CHAIN_CONTEXT_FORMAT, payload: chain },
    });

    it("keeps the newest context per chain, and hands the SDK only ciphertext", () => {
        const { records, chains } = splitHostEntries([
            { entryId: "r1", record: { format: "nihilium-vault-blob-v1", payload: {} } },
            context(row(1, "old-key"), 10),
            context(row(2, "re-keyed"), 20),
        ]);
        expect(records.map((r) => r.entryId)).toEqual(["r1"]);
        expect(chains.map((c) => c.recoveryPubKeyHex)).toEqual(["re-keyed"]);
    });

    it("prefers the host's newer row over a seal file's older copy of the same chain", async () => {
        // A chain re-keyed after the download: the file's key is one the chain no longer holds.
        const host = memoryHost();
        const fresh = device();
        const stale = { ...row(1, "old-key"), chainId: "solana-devnet" };
        await host.append("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", context(row(2, "re-keyed"), 0));
        const vault = {
            vaultId: "v",
            recordId: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
            chains: [stale],
        } as never;
        await fresh.vaults.put(vault);
        const pulled = await refreshVaultFromHost(fresh, host, vault);
        expect(pulled.vault.chains.map((c) => c.recoveryPubKeyHex)).toEqual(["re-keyed"]);
    });
});
