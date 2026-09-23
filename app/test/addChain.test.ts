/**
 * `addChain()` is free, and this is the test that says so in numbers.
 *
 * It is the asymmetry the whole repo is built to make visible: a ceremony is paid, plural, online
 * and slow; putting another chain into the vault it produced contacts nobody. Before this existed,
 * switching to Solana in the UI reported "not set up" and offered a second paid ceremony — the
 * failure mode this asserts against.
 *
 * Driven through the real `QuorumConditionAdapter`, the real `RecoverySDK` and the app's own
 * `sealVault` / `addChainToVault`, against the local cohort rather than the live one: a test that
 * bought three seals per run is a test nobody runs.
 */
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EvmKeyAdapter } from "@nihilium/recovery-key-evm";
import { SolanaKeyAdapter, SOLANA_NAMESPACE } from "@nihilium/recovery-key-solana";
import { generateRRS, type ConditionAdapter } from "@nihilium/recovery-core";
import { createDemoCohort } from "../src/integration/conditions/simulated/cohort.js";
import { createEmailQuorumMethod } from "../src/integration/conditions/emailQuorum.js";
import { createEmailSubjectKind } from "../src/integration/conditions/subjects/email.js";
import { addChainToVault, sealVault } from "../src/integration/recovery/vault.js";
import { VaultRecordStore, chainContextOf, type VaultRecord } from "../src/integration/recovery/vaultRecords.js";
import { IdbSealedDataStore } from "../src/integration/storage/dataStore.js";
import { IdbSealStore } from "../src/integration/storage/sealStore.js";
import type { ChainModule, DerivedAccount } from "../src/integration/chains/types.js";

const EMAILS = ["alice@gmail.com", "bob@proton.me", "carol@outlook.com"];

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

const WALLET = "wallet-under-test";

const EVM = stubChain({ id: "evm-sepolia", namespace: "eip155:11155111" });
const SOLANA = stubChain({
    id: "solana-devnet",
    namespace: SOLANA_NAMESPACE.devnet,
    // A second curve, which is the point: one vault holds an ed25519 chain beside a secp256k1 one.
    keyAdapter: new SolanaKeyAdapter(),
});

function account(accountId: string): DerivedAccount {
    return { accountId, address: accountId, label: "a", derivationPath: "m", index: 0 } as DerivedAccount;
}

const EVM_ACCOUNT = account("0xCfC4C807Ed404ae1a65fbe0EdaA09EF002E75838");
const SOLANA_ACCOUNT = account("So11111111111111111111111111111111111111112");

function setup(dbName: string) {
    const cohort = createDemoCohort();
    const method = createEmailQuorumMethod({
        mode: "simulated",
        paid: false,
        kind: createEmailSubjectKind({
            adapterFor: (_subject, index): ConditionAdapter => cohort.adapterFor(index),
        }),
    });
    const stores = {
        sealStore: new IdbSealStore({ dbName }),
        dataStore: new IdbSealedDataStore({ dbName }),
        vaults: new VaultRecordStore({ dbName }),
    };
    const subjects = EMAILS.map(
        (email) => (method.kinds[0]!.parse({ kindId: "email", values: { email } }) as { subject: unknown })
            .subject,
    ) as Parameters<typeof sealVault>[1]["subjects"];
    return { cohort, method, stores, subjects };
}

describe("one vault, every chain", () => {
    it("adds a second chain without contacting a single guardian", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { cohort, method, stores, subjects } = setup(dbName);

        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-one-for-all",
            walletId: WALLET,
        });

        // One ceremony per guardian for the vault. This is what was paid for.
        expect(cohort.stats().map((m) => m.stats.ceremonies)).toEqual([1, 1, 1]);

        const updated = await addChainToVault(stores, {
            method,
            vault,
            chain: SOLANA,
            account: SOLANA_ACCOUNT,
        });

        // Still one each. Nothing was re-run, nobody was asked, nothing was billed — which is the
        // entire claim `addChain()` makes, asserted rather than described.
        expect(cohort.stats().map((m) => m.stats.ceremonies)).toEqual([1, 1, 1]);
        expect(updated.chains.map((c) => c.chainId)).toEqual(["evm-sepolia", "solana-devnet"]);
    });

    it("derives the second chain's key on that chain's own curve", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);

        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-two-curves",
            walletId: WALLET,
        });
        const updated = await addChainToVault(stores, {
            method,
            vault,
            chain: SOLANA,
            account: SOLANA_ACCOUNT,
        });

        // The curve belongs to the chain, not to the vault or the SDK instance.
        expect(updated.chains[0]!.algorithm).toBe("secp256k1");
        expect(updated.chains[1]!.algorithm).toBe("ed25519");
        // And the namespace is the one the chain module pinned, never a cluster name.
        expect(updated.chains[1]!.namespace).toBe(SOLANA_NAMESPACE.devnet);
    });

    it("keeps the same gate, the same vaultId and the same recordId", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);

        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-same-gate",
            walletId: WALLET,
        });
        const updated = await addChainToVault(stores, {
            method,
            vault,
            chain: SOLANA,
            account: SOLANA_ACCOUNT,
        });

        // It is the same compartment: same guardians, same seal, same lookup handle. Only the
        // contents grew.
        expect(updated.vaultId).toBe(vault.vaultId);
        expect(updated.recordId).toBe(vault.recordId);
        expect(updated.gate).toEqual(vault.gate);
    });

    it("refuses to add a chain the vault already holds", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);

        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-no-dupes",
            walletId: WALLET,
        });

        // Two root secrets for one chain in one vault, and no way for a recovery to say which is
        // current — refused here rather than discovered at recovery time.
        await expect(
            addChainToVault(stores, { method, vault, chain: EVM, account: EVM_ACCOUNT }),
        ).rejects.toThrow(/already in vault/);
    });

    it("survives a reload: the ledger holds both chains", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);

        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-persisted",
            walletId: WALLET,
        });
        await addChainToVault(stores, { method, vault, chain: SOLANA, account: SOLANA_ACCOUNT });

        // Read back through a *fresh* store, the way a reload does.
        const reopened = await new VaultRecordStore({ dbName }).get("vault-persisted");
        expect(reopened?.chains.map((c) => c.chainId)).toEqual(["evm-sepolia", "solana-devnet"]);
    });
});


describe("the vault is found from every chain it covers", () => {
    /**
     * The regression this exists for.
     *
     * The lookup used to compare the *current chain's* account id against each chain record's
     * `accountId`. That finds the vault on the chain it was sealed from and misses it everywhere
     * else, because each chain's protected account is a different kind of thing — an EVM smart
     * account here, a program-owned PDA on Solana that is not the wallet's key at all. The symptom
     * was the one that matters most: switch to Solana, see "no recovery", and be offered a second
     * paid ceremony for a wallet that already had a perfectly good gate.
     *
     * One seal covering both chains is the entire point of this demo, so it is pinned here rather
     * than left to the UI to get right.
     */
    function lookup(vaults: readonly VaultRecord[]) {
        return (chainId: string, walletId: string) =>
            vaults.find(
                (vault) => vault.walletId === walletId && vault.chains.some((c) => c.chainId === chainId),
            ) ?? null;
    }

    it("finds one vault from both chains, and never a second ceremony", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { cohort, method, stores, subjects } = setup(dbName);

        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-shared",
            walletId: WALLET,
        });
        const updated = await addChainToVault(stores, {
            method,
            vault,
            chain: SOLANA,
            account: SOLANA_ACCOUNT,
        });

        const vaultFor = lookup([updated]);
        // The same vault id from both chains. Two ids here would be two seals.
        expect(vaultFor("evm-sepolia", WALLET)?.vaultId).toBe("vault-shared");
        expect(vaultFor("solana-devnet", WALLET)?.vaultId).toBe("vault-shared");
        expect(cohort.stats().map((m) => m.stats.ceremonies)).toEqual([1, 1, 1]);
    });

    it("does not show one wallet's vault against another", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);
        const { vault } = await sealVault(stores, {
            method,
            subjects,
            threshold: 2,
            chain: EVM,
            account: EVM_ACCOUNT,
            vaultId: "vault-seed-a",
            walletId: WALLET,
        });

        // A different seed is a different wallet, and its accounts are not this vault's.
        expect(lookup([vault])("evm-sepolia", "some-other-seed")).toBeNull();
    });
});

describe("a chain whose settlement must sign its own registration", () => {
    /**
     * Solana's `register` verifies a detached signature **by the incoming guardian** — the recovery
     * key itself. `addChain()` normally mints that key's root, derives the public half and wipes
     * the rest, so the app is left with an address it cannot sign with. Supplying the root is the
     * SDK's own seam for this, and these pin that the key it produces is the one that can sign.
     */
    it("derives a usable private half from a caller-supplied root", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);
        const { vault } = await sealVault(stores, {
            method, subjects, threshold: 2, chain: EVM, account: EVM_ACCOUNT,
            vaultId: "vault-own-root", walletId: WALLET,
        });

        const rrs = generateRRS();
        const updated = await addChainToVault(stores, {
            method, vault, chain: SOLANA, account: SOLANA_ACCOUNT,
            recoveryKey: { kind: "rrs", rrs },
        });
        const record = updated.chains.find((c) => c.chainId === "solana-devnet")!;

        // The half the vault recorded and the half the root derives must be the same key, or the
        // signature would be by a different key than the one being installed — which is exactly
        // the `SignerMismatch` the program raises.
        const priv = SOLANA.keyAdapter.derivePrivateKey(rrs, chainContextOf(updated, record));
        const pub = SOLANA.keyAdapter.publicKeyFor(priv);
        expect(bytesToHex(pub.bytes)).toBe(record.recoveryPubKeyHex);
    });

    it("re-keys a chain already present rather than adding it twice", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);
        const { vault } = await sealVault(stores, {
            method, subjects, threshold: 2, chain: EVM, account: EVM_ACCOUNT,
            vaultId: "vault-rekey", walletId: WALLET,
        });
        const once = await addChainToVault(stores, {
            method, vault, chain: SOLANA, account: SOLANA_ACCOUNT,
        });
        const first = once.chains.find((c) => c.chainId === "solana-devnet")!.recoveryPubKeyHex;

        const twice = await addChainToVault(stores, {
            method, vault: once, chain: SOLANA, account: SOLANA_ACCOUNT, rekey: true,
        });
        const solanaRows = twice.chains.filter((c) => c.chainId === "solana-devnet");

        // Exactly one row, holding a new key. Two roots for one chain would leave a recovery with
        // no way to say which is current.
        expect(solanaRows).toHaveLength(1);
        expect(solanaRows[0]!.recoveryPubKeyHex).not.toBe(first);
    });

    it("still refuses a plain double-add", async () => {
        const dbName = `add-chain-${crypto.randomUUID()}`;
        const { method, stores, subjects } = setup(dbName);
        const { vault } = await sealVault(stores, {
            method, subjects, threshold: 2, chain: EVM, account: EVM_ACCOUNT,
            vaultId: "vault-no-dup", walletId: WALLET,
        });
        const once = await addChainToVault(stores, {
            method, vault, chain: SOLANA, account: SOLANA_ACCOUNT,
        });
        await expect(
            addChainToVault(stores, { method, vault: once, chain: SOLANA, account: SOLANA_ACCOUNT }),
        ).rejects.toThrow(/already in vault/);
    });
});
