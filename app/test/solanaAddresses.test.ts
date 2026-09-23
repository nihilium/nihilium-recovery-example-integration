/**
 * The Solana addresses, and the one that can never be protected.
 *
 * The vault PDA is `ChainContext.accountId` — an HKDF input. Deriving it differently at recovery
 * than at seal time does not fail: it yields a different, perfectly valid key for an account that
 * has never heard of it. So the derivation is pinned here, against the real devnet program id.
 *
 * The seeds use **creator**, never owner. A recovery rotates the owner, and an owner in the seeds
 * would move the vault's address on every rotation, orphaning every seal derived against it — the
 * test below is what would catch that if someone "fixed" it.
 */
import { describe, expect, it } from "vitest";
import { createSolanaDevnetChain } from "../src/integration/chains/solana.js";
import { PublicKey } from "@solana/web3.js";
import { recoveryVaultProgramIds, vaultAddress } from "@nihilium/recovery-onchain-solana";
import {
    programIdFor,
    programVaultId,
    solanaVaultAddresses,
} from "../src/integration/recovery/settlement/solana/addresses.js";

const DEVNET = "devnet";
const CREATOR = "So11111111111111111111111111111111111111112";

describe("the program id", () => {
    it("is the deployed devnet program", () => {
        expect(programIdFor(DEVNET).toBase58()).toBe(
            "DaLebS3k5gD1k42uGU6LPnSP9qTNwYxaKqLQBb7BqgkG",
        );
        expect(recoveryVaultProgramIds[DEVNET]).toBe(programIdFor(DEVNET).toBase58());
    });

    it("refuses a cluster with no deployment rather than guessing", () => {
        // A guessed program id derives a vault address that holds nothing and never will.
        expect(() => programIdFor("mainnet-beta")).toThrow(/not deployed/);
        expect(() => programIdFor("localnet")).toThrow(/not deployed/);
    });
});

describe("programVaultId", () => {
    /**
     * This file used to assert the opposite, and that assertion cost real funds.
     *
     * It required a new SDK vault id to land on a *different* PDA, reasoning that a re-seal is a
     * new compartment. But the PDA is the **account** — Solana's answer to a Safe address — and the
     * SDK vault id labels the **gate**. Tying one to the other meant replacing your guardians moved
     * your account and stranded everything in the old one, while the same rotation on EVM
     * re-installed a module on the same Safe and lost nothing.
     */
    it("is 16 bytes and the same for every gate", () => {
        const a = programVaultId();
        expect(a).toHaveLength(16);
        expect(programVaultId()).toEqual(a);
    });
});

describe("solanaVaultAddresses", () => {
    it("derives both PDAs, reproducibly", () => {
        const first = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        const again = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        // Reproducible from the ledger row alone, which is what a recovery has to do.
        expect(first.vault.toBase58()).toBe(again.vault.toBase58());
        expect(first.vaultSol.toBase58()).toBe(again.vaultSol.toBase58());
        // Two different PDAs: one is the account, the other holds the lamports.
        expect(first.vault.toBase58()).not.toBe(first.vaultSol.toBase58());
    });

    it("matches the program's own derivation", () => {
        // Against the binding directly, so a change to our wrapper cannot drift from the program.
        const [expected] = vaultAddress(
            programIdFor(DEVNET),
            new PublicKey(CREATOR),
            programVaultId(),
        );
        const ours = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        expect(ours.vault.toBase58()).toBe(expected.toBase58());
    });

    it("moves with the creator, so two wallets never share a vault", () => {
        const mine = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        const theirs = solanaVaultAddresses({
            cluster: DEVNET,
            creator: "11111111111111111111111111111112",
        });
        expect(mine.vault.toBase58()).not.toBe(theirs.vault.toBase58());
    });

    it("does not move when the owner rotates", () => {
        // There is no owner in this call at all, and that is the point: a recovery rotates the
        // owner, and a vault address that moved with it would orphan every seal derived against it.
        const before = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        const after = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        expect(after.vault.toBase58()).toBe(before.vault.toBase58());
    });

    it("does not move when the gate is replaced", () => {
        /**
         * The regression, in one assertion.
         *
         * Re-sealing mints a new SDK vault id. When that fed the PDA seed, replacing your guardians
         * created a *new* vault at a new address and left the balance in the old one — while the
         * identical rotation on EVM re-installed a module on the same Safe and lost nothing. The
         * account belongs to the wallet; the gate is what changes.
         */
        const underGateA = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        // Nothing about a gate is an input here any more, which is what makes this true by
        // construction rather than by luck.
        const underGateB = solanaVaultAddresses({ cluster: DEVNET, creator: CREATOR });
        expect(underGateB.vault.toBase58()).toBe(underGateA.vault.toBase58());
        expect(underGateB.vaultSol.toBase58()).toBe(underGateA.vaultSol.toBase58());
    });
});

describe("each chain validates its own destinations", () => {
    /**
     * `SendDialog` used to test `/^0x[0-9a-fA-F]{40}$/` for every chain, so the Send button could
     * never enable on Solana — the form silently could not send anywhere but EVM. The answer
     * belongs to the chain, and these pin that each one refuses the others'.
     */
    const EVM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const SOL = "8ZBXC6KWco1ra7ZngmTJaEZKTwHeZYCi6YVTpT9429aT";

    const solana = createSolanaDevnetChain({ rpcUrl: "http://127.0.0.1:8899" });

    it("accepts a 32-byte base58 address", () => {
        expect(solana.isValidAddress(SOL)).toBe(true);
        expect(solana.isValidAddress(` ${SOL} `)).toBe(true);
    });

    it("refuses an EVM address, which the old shared regex was the only thing accepting", () => {
        expect(solana.isValidAddress(EVM)).toBe(false);
    });

    it("refuses base58 of the wrong length, which a pattern would have let through", () => {
        // Valid base58, 31 bytes. An address is 32; a regex over the alphabet cannot tell.
        expect(solana.isValidAddress("11111111111111111111111111111")).toBe(false);
    });

    it("refuses characters outside the base58 alphabet", () => {
        expect(solana.isValidAddress("0OIl" + SOL.slice(4))).toBe(false);
        expect(solana.isValidAddress("")).toBe(false);
    });
});

describe("the account the seed derives", () => {
    /**
     * A lose-your-funds rule, not a display preference.
     *
     * A Solana vault is two accounts: the Anchor account that *is* `ChainContext.accountId`, and a
     * system-owned PDA that holds the lamports. `execute_transfer` is the only instruction that can
     * move value and it spends the second; nothing debits the first and there is no close
     * instruction. So `address` — what the UI shows and copies — must be the sol account, and
     * `accountId` must be the identity. Swapping them strands every deposit.
     */
    const solana = createSolanaDevnetChain({ rpcUrl: "http://127.0.0.1:8899" });
    const seed = new Uint8Array(64).fill(7);

    it("returns one account: the vault, keyed by identity and shown by its sol account", async () => {
        const [account] = await solana.deriveAccounts(seed);
        const addresses = solanaVaultAddresses({ cluster: DEVNET, creator: account!.signer.address });

        expect(account!.accountId).toBe(addresses.vault.toBase58());
        expect(account!.address).toBe(addresses.vaultSol.toBase58());
        expect(account!.accountId).not.toBe(account!.address);
    });

    it("is derivable from the seed alone, before any vault exists", async () => {
        // The whole reason the card can show an address on a fresh wallet, and the reason
        // `addChain` needs no chain read: counterfactual, exactly like the EVM smart account.
        const [a] = await solana.deriveAccounts(seed);
        const [b] = await solana.deriveAccounts(seed);
        expect(b!.accountId).toBe(a!.accountId);
        expect(solana.isValidAddress(a!.address)).toBe(true);
    });

    it("keeps the signer separate from the account it drives", async () => {
        const [account] = await solana.deriveAccounts(seed);
        // The key is unrecoverable by construction; the account it controls is not.
        expect(account!.signer.address).not.toBe(account!.accountId);
        expect(account!.signer.address).not.toBe(account!.address);
    });
});
