/**
 * What Reset would cost: every seed whose accounts still hold something, and whether anything but the
 * phrase could reach them afterwards.
 *
 * Reset deletes the seeds, and in this demo a seed exists nowhere else. An account with a balance is
 * then reachable only two ways: by the phrase, if the user kept it, or by recovery — which needs the
 * account protected on-chain **and** the seal file, since the seal goes with the reset too. A seed
 * whose funded account is sealed but not protected is the case that looked safe and was not: the
 * vault opens, and the chain has nothing that would accept its key.
 *
 * Demo-only: it reads the seed book, which nothing outside `demo/` may know about.
 */
import type { CoverageRow } from "../integration/recovery/settlement/coverage.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { AppBindings } from "./bindings.js";
import { seedFingerprint, type SeedEntry } from "./seeds.js";
import { readCoverage } from "./useChainCoverage.js";
import { deriveWallet } from "./wallet.js";

export type AccountReach =
    /** This vault's key is registered on-chain: recoverable, given the seal file. */
    | "protected"
    /** Nothing on-chain would accept a recovery. Only the phrase reaches this account. */
    | "phrase-only"
    /** The chain could not be read. Not a pass. */
    | "unknown";

export interface AccountAtRisk {
    chainLabel: string;
    /** `null` when the balance could not be read — shown as unknown, never as empty. */
    balance: { raw: bigint; decimals: number; symbol: string } | null;
    reach: AccountReach;
}

export interface SeedAtRisk {
    label: string;
    mnemonic: string;
    accounts: AccountAtRisk[];
}

export async function readSeedRisks(
    bindings: Pick<AppBindings, "chains" | "env" | "stores">,
    seeds: readonly SeedEntry[],
    vaults: readonly VaultRecord[],
): Promise<SeedAtRisk[]> {
    const rows = await Promise.all(
        seeds.map(async (seed): Promise<SeedAtRisk | null> => {
            const walletId = seedFingerprint(seed.mnemonic);
            // The same lookup the recovery card uses, so the two can never disagree about which gate
            // protects a seed.
            const vault = vaults.find((row) => row.walletId === walletId) ?? null;
            const wallet = await deriveWallet(bindings.chains, seed.mnemonic);
            const coverage = await readCoverage(bindings, wallet, vault);

            const accounts = coverage.filter(holdsSomething).map((row) => ({
                chainLabel: row.chainLabel,
                balance:
                    row.balanceRaw === null
                        ? null
                        : {
                              raw: row.balanceRaw,
                              decimals: row.balanceDecimals ?? 18,
                              symbol: row.balanceSymbol ?? "",
                          },
                reach: reachOf(row),
            }));
            return accounts.length === 0 ? null : { label: seed.label, mnemonic: seed.mnemonic, accounts };
        }),
    );
    return rows.filter((row): row is SeedAtRisk => row !== null);
}

/**
 * A balance above zero, or one that could not be read — an unreadable account may hold anything. A
 * simulated balance is not funds: nothing is lost with it, and listing it would present a fiction as
 * money at risk.
 */
function holdsSomething(row: CoverageRow): boolean {
    if (row.balanceSimulated === true) return false;
    return row.balanceRaw === null ? row.balanceError !== "no account derived" : row.balanceRaw > 0n;
}

function reachOf(row: CoverageRow): AccountReach {
    if (!row.hasVault || row.vaultSpent || !row.settles) return "phrase-only";
    if (row.onchain === null) return row.onchainError === null ? "phrase-only" : "unknown";
    return row.onchain.installed && row.onchain.matchesVault ? "protected" : "phrase-only";
}
