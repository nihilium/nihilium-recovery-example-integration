/**
 * One seal, both chains, **one** round of guardian email.
 *
 * This is the claim the whole repo is built to make, and the one place it could quietly stop being
 * true. `RecoverySDK.recover()` returns a single chain's authority per call, and the paid,
 * human-in-the-loop part of a recovery is `ConditionAdapter.openRecords` — so the obvious
 * implementation, a loop of `recover()` calls, emails every guardian once per chain. It works. It
 * costs n ceremonies, and nothing in the stack reports that it did.
 *
 * So the ceremony count is asserted from the **guardians' side**, through the demo cohort's own
 * counters, rather than from the wrapper's bookkeeping. A wrapper that miscounted its own work would
 * still fail these.
 *
 * Driven through the real quorum adapter, the real SDK and the app's own seal/add/recover, against
 * the local cohort — a test that bought seals per run is a test nobody runs.
 */
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EvmKeyAdapter, toEvmAddress } from "@nihilium/recovery-key-evm";
import { SolanaKeyAdapter, SOLANA_NAMESPACE, toSolanaAddress } from "@nihilium/recovery-key-solana";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import { createDemoCohort } from "../src/integration/conditions/simulated/cohort.js";
import { createEmailQuorumMethod } from "../src/integration/conditions/emailQuorum.js";
import { createEmailSubjectKind } from "../src/integration/conditions/subjects/email.js";
import { addChainToVault, sealVault } from "../src/integration/recovery/vault.js";
import { recoverAllChains } from "../src/integration/recovery/recoverAll.js";
import { VaultRecordStore } from "../src/integration/recovery/vaultRecords.js";
import { IdbSealedDataStore } from "../src/integration/storage/dataStore.js";
import { IdbSealStore } from "../src/integration/storage/sealStore.js";
import type { ChainModule, ChainRegistry, DerivedAccount } from "../src/integration/chains/types.js";

const EMAILS = ["alice@gmail.com", "bob@proton.me", "carol@outlook.com"];
const WALLET = "wallet-under-test";

function stubChain(over: Partial<ChainModule> & Pick<ChainModule, "id" | "namespace">): ChainModule {
    return {
        label: over.id,
        icon: "ethereum",
        tier: "smart-account",
        keyAdapter: new EvmKeyAdapter(),
        deriveAccounts: async () => [],
        formatAddress: (a) => a,
        addressOfPublicKey: (pub) => toEvmAddress(pub),
        isValidAddress: () => true,
        explorerUrl: () => null,
        balanceOf: async () => ({ raw: 0n, decimals: 18, symbol: "ETH", source: "chain" }),
        settlement: null,
        send: null,
        ...over,
    } as ChainModule;
}

const EVM = stubChain({ id: "evm-sepolia", namespace: "eip155:11155111" });
const SOLANA = stubChain({
    id: "solana-devnet",
    namespace: SOLANA_NAMESPACE.devnet,
    // A second curve, which is the point: one vault holds an ed25519 chain beside a secp256k1 one,
    // and a recovery has to derive each on its own.
    keyAdapter: new SolanaKeyAdapter(),
    addressOfPublicKey: (pub) => toSolanaAddress(pub),
});

function registryOf(chains: ChainModule[]): ChainRegistry {
    return {
        all: () => chains,
        get: (id) => chains.find((chain) => chain.id === id),
        require: (id) => {
            const found = chains.find((chain) => chain.id === id);
            if (found === undefined) throw new Error(`no chain ${id}`);
            return found;
        },
    };
}

function account(accountId: string, signerAddress = `signer-of-${accountId}`): DerivedAccount {
    return {
        accountId,
        address: accountId,
        label: "a",
        derivationPath: "m",
        index: 0,
        // Present because `VaultChainRecord.signerAddress` records it: on Solana the account is a
        // PDA seeded by its creator, and a recovery run from a different seed cannot rebuild the
        // addresses without knowing which key that was.
        signer: { address: signerAddress },
    } as DerivedAccount;
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

/** A vault covering both chains, and the guardians asked exactly once to build it. */
async function twoChainVault(dbName: string, vaultId: string) {
    const { cohort, method, stores, subjects } = setup(dbName);
    const { vault } = await sealVault(stores, {
        method,
        subjects,
        threshold: 2,
        chain: EVM,
        account: EVM_ACCOUNT,
        vaultId,
        walletId: WALLET,
    });
    const full = await addChainToVault(stores, {
        method,
        vault,
        chain: SOLANA,
        account: SOLANA_ACCOUNT,
    });
    return { cohort, method, stores, vault: full };
}

describe("recovering every chain a vault covers", () => {
    it("asks the guardians once, for two chains", async () => {
        const dbName = `recover-all-${crypto.randomUUID()}`;
        const { cohort, method, stores, vault } = await twoChainVault(dbName, "vault-one-ceremony");

        // Sealing bought one ceremony per guardian. Adding Solana bought none, and no recovery has
        // been run, so nobody has been asked to open anything.
        expect(cohort.stats().map((m) => m.stats.ceremonies)).toEqual([1, 1, 1]);
        expect(cohort.stats().map((m) => m.stats.recoveries)).toEqual([0, 0, 0]);

        const result = await recoverAllChains(stores, {
            method,
            gate: vault.gate,
            selected: [1, 2],
            vault,
            chains: registryOf([EVM, SOLANA]),
        });

        // **The assertion this file exists for.** Two chains recovered, and each named guardian was
        // asked exactly *once* — not once per chain. A loop of `recover()` calls reads [2, 2, 0]
        // here, passes every other test in this file, and silently doubles what a recovery costs.
        expect(cohort.stats().map((m) => m.stats.recoveries)).toEqual([1, 1, 0]);
        // Sealing is untouched: recovering does not re-seal.
        expect(cohort.stats().map((m) => m.stats.ceremonies)).toEqual([1, 1, 1]);
        expect(result.ceremonies).toBe(1);
        expect(result.keys).toHaveLength(2);
        result.wipe();
    });

    it("derives each chain's key on that chain's own curve, and proves it against the seal", async () => {
        const dbName = `recover-all-${crypto.randomUUID()}`;
        const { method, stores, vault } = await twoChainVault(dbName, "vault-two-curves");

        const result = await recoverAllChains(stores, {
            method,
            gate: vault.gate,
            selected: [1, 2],
            vault,
            chains: registryOf([EVM, SOLANA]),
        });

        for (const key of result.keys) {
            const sealed = vault.chains.find((row) => row.chainId === key.chainId)!;
            expect(key.failure, key.chainId).toBeNull();
            // The only check that catches a wrong epoch — an HKDF input the envelope does not carry,
            // so a wrong one yields a valid key for an account that never heard of it.
            expect(key.publicKeyHex, key.chainId).toBe(sealed.recoveryPubKeyHex);
        }

        const evm = result.keys.find((k) => k.chainId === "evm-sepolia")!;
        const solana = result.keys.find((k) => k.chainId === "solana-devnet")!;
        expect(evm.chainRecord.algorithm).toBe("secp256k1");
        expect(solana.chainRecord.algorithm).toBe("ed25519");
        // Chain-native, via `addressOfPublicKey`. Two curves, two address formats, neither guessed
        // from the other.
        expect(evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(solana.address).not.toMatch(/^0x/);
        result.wipe();
    });

    it("hands back live key material, not the buffers the SDK already wiped", async () => {
        /**
         * The specific bug the copy in `oneCeremony.ts` exists to prevent. `recover()` zeroes every
         * plaintext it is handed, so a cache that returned its originals would be emptied by the
         * first chain and the second would decrypt nothing — surfacing as "these records belong to
         * another vault", which points nowhere near the cause.
         */
        const dbName = `recover-all-${crypto.randomUUID()}`;
        const { method, stores, vault } = await twoChainVault(dbName, "vault-not-wiped");

        const result = await recoverAllChains(stores, {
            method,
            gate: vault.gate,
            selected: [1, 2],
            vault,
            chains: registryOf([EVM, SOLANA]),
        });

        // The *second* chain in the loop is the one a shared-buffer bug would break.
        const second = result.keys[1]!;
        expect(second.failure).toBeNull();
        expect(second.material).not.toBeNull();
        expect(second.material!.some((byte) => byte !== 0)).toBe(true);
        result.wipe();
    });

    it("reports the SDK's own spent notice, once, verbatim", async () => {
        const dbName = `recover-all-${crypto.randomUUID()}`;
        const { method, stores, vault } = await twoChainVault(dbName, "vault-spent");

        const result = await recoverAllChains(stores, {
            method,
            gate: vault.gate,
            selected: [1, 2],
            vault,
            chains: registryOf([EVM, SOLANA]),
        });

        // Not paraphrased here. It is a claim about the protocol and the SDK owns the wording — the
        // reason this batches through `recover()` rather than reimplementing it.
        expect(result.spent?.reason).toContain("every chain it protects has now been exposed");
        expect(result.spent?.vaultId).toBe("vault-spent");
        result.wipe();
    });

    it("keeps the other chains when one has no module in this build", async () => {
        const dbName = `recover-all-${crypto.randomUUID()}`;
        const { cohort, method, stores, vault } = await twoChainVault(dbName, "vault-missing-chain");

        // Solana dropped from the registry: a vault outliving a chain this build supports.
        const result = await recoverAllChains(stores, {
            method,
            gate: vault.gate,
            selected: [1, 2],
            vault,
            chains: registryOf([EVM]),
        });

        const evm = result.keys.find((k) => k.chainId === "evm-sepolia")!;
        const solana = result.keys.find((k) => k.chainId === "solana-devnet")!;
        expect(evm.failure).toBeNull();
        expect(evm.publicKeyHex).toBe(
            vault.chains.find((c) => c.chainId === "evm-sepolia")!.recoveryPubKeyHex,
        );
        // A row, not a throw. Throwing would lose the EVM key and cost a second paid ceremony to
        // get it back — for a failure that has nothing to do with EVM.
        expect(solana.failure).toContain("No chain module");
        expect(solana.material).toBeNull();
        // And still exactly one round of email, even though one chain failed.
        expect(cohort.stats().map((m) => m.stats.recoveries)).toEqual([1, 1, 0]);
        result.wipe();
    });

    it("zeroizes every chain's key on wipe", async () => {
        const dbName = `recover-all-${crypto.randomUUID()}`;
        const { method, stores, vault } = await twoChainVault(dbName, "vault-wipe");

        const result = await recoverAllChains(stores, {
            method,
            gate: vault.gate,
            selected: [1, 2],
            vault,
            chains: registryOf([EVM, SOLANA]),
        });

        const before = result.keys.map((key) => bytesToHex(key.material!));
        expect(before.every((hex) => /[1-9a-f]/.test(hex))).toBe(true);

        result.wipe();

        for (const key of result.keys) {
            expect(key.material!.every((byte) => byte === 0), key.chainId).toBe(true);
        }
    });
});
