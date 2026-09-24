/**
 * Every transaction this app causes, and what each one costs in its chain's own units.
 *
 * A table rather than a live `estimateGas`, because most of these calls cannot be estimated before
 * they are legal: `initiateRecovery` needs a signature from a key the ceremony has not produced yet,
 * `executeRecovery` needs a matured timelock, and an `eth_estimateGas` against either reverts. So the
 * numbers are **measured from transactions this demo actually sent**, each one carrying the hash it
 * came from, and the few with no sample yet say so in `basis`.
 *
 * That distinction is the whole point of `basis`. An estimate built partly on assumptions is still
 * worth showing — it is the difference between "about a dollar" and "about forty" — but it must not
 * pass for a measurement. `estimateCost` propagates the weakest basis of everything it adds up.
 *
 * **To replace:** all of it. These are facts about *this* module, *this* program and the Safe
 * configuration in `chains/safeAccount.ts`; nothing here transfers to another deployment. Re-measure
 * by reading `gasUsed` off your own receipts — the app records every hash it sends (`settlement`
 * `txHash`, and `initiateTx`/`executeTx`/`sweepTx` on each `HandoverRecord`).
 * **Assumes:** the EVM figures are `actualGasUsed` from the `UserOperationEvent` where the call is a
 * UserOp and `receipt.gasUsed` where it is a plain transaction — the two are not interchangeable,
 * since a UserOp's own overhead is charged to the account rather than to the bundler's transaction.
 */

export type CostOperation = "protect" | "recover" | "move-funds";

/**
 * Who is out of pocket. Worth carrying per step rather than per chain: a recovery is paid for by
 * three different parties and the split is one of the things this demo exists to make visible.
 */
export type Payer = "you" | "the account" | "the relayer";

/** `measured` means a transaction hash in `note`. Nothing else may claim it. */
export type Basis = "measured" | "assumed";

export interface WorkStep {
    label: string;
    payer: Payer;
    basis: Basis;
    /** Where the number came from: a transaction hash, or the reasoning behind an assumption. */
    note: string;
    /** EVM only: gas units, priced at the mainnet gas price. */
    evmGas?: bigint;
    /** Solana only: the fee in lamports, measured rather than derived — see `SOLANA_FEE_NOTE`. */
    lamports?: bigint;
    /** Solana only: rent-exemption. A deposit that comes back when the account closes, not a fee. */
    rentLamports?: bigint;
}

/**
 * Why Solana fees are stored and not computed.
 *
 * The obvious model is 5000 lamports per signature, and it is wrong here: `register` and
 * `initiate_recovery` carry an **Ed25519 precompile instruction**, whose signature is charged like a
 * transaction signature. Both measure 15,000 lamports against two signers rather than the 10,000 a
 * signer count predicts. The base rate is protocol-fixed and identical on mainnet, so a devnet
 * measurement transfers exactly — a derivation that missed the precompile would not.
 */
export const SOLANA_FEE_NOTE = "base fee only — priority fees are excluded, and vary with congestion";

export interface WorkContext {
    /**
     * Whether the EVM smart account already exists on chain.
     *
     * Worth a factor of three: a Safe's **first** UserOp runs the whole launchpad deployment out of
     * the same gas — proxy, module setup, singleton swap — which is why `chains/evm.ts` reserves
     * twice what a Kernel account needed.
     */
    accountDeployed: boolean;
    /** Whether protecting replaces an installed module, which prepends an `uninstallModule` call. */
    replacing: boolean;
    /** Whether the Solana vault PDA exists, so `create_vault` and its rent are already paid. */
    vaultExists: boolean;
}

/** `null` where a chain performs no transaction for this operation. Zcash, always — see below. */
export function workFor(
    operation: CostOperation,
    chainId: string,
    ctx: WorkContext,
): WorkStep[] | null {
    if (chainId === "evm-sepolia") return evmWork(operation, ctx);
    if (chainId === "solana-devnet") return solanaWork(operation, ctx);
    // Zcash and anything else this build does not settle. `null` is not zero: the row still renders,
    // saying there is no transaction, because a chain quietly missing from a total is a total that
    // is wrong without looking wrong.
    return null;
}

function evmWork(operation: CostOperation, ctx: WorkContext): WorkStep[] {
    switch (operation) {
        case "protect": {
            const steps: WorkStep[] = [
                {
                    label: ctx.replacing ? "uninstallModule + installModule" : "installModule",
                    payer: "the account",
                    evmGas: 268_038n,
                    basis: "measured",
                    // Four samples, all of them replacements: 255,401 once and 268,038 three times.
                    // A first install does the same work minus the uninstall and has no sample of
                    // its own, so it is charged the replacement's price — an over-estimate, which is
                    // the safe direction for a number shown before a button.
                    note: "actualGasUsed on tx 0xb228e049…cd3a6998",
                },
            ];
            if (!ctx.accountDeployed) {
                steps.push({
                    label: "Safe deployment (first UserOp)",
                    payer: "the account",
                    evmGas: 450_000n,
                    basis: "assumed",
                    note: "no sample: every measured install ran against a deployed account",
                });
            }
            return steps;
        }
        case "recover":
            return [
                {
                    label: "initiateRecovery",
                    payer: "the relayer",
                    evmGas: 84_597n,
                    basis: "measured",
                    note: "gasUsed on tx 0x9d5e109e…9217861c",
                },
                {
                    label: "executeRecovery",
                    payer: "the relayer",
                    evmGas: 200_000n,
                    basis: "assumed",
                    note: "no sample: it installs a validator on the account, so roughly an install",
                },
            ];
        case "move-funds":
            return [
                {
                    label: "execute (sweep, as the recovered owner)",
                    payer: "the account",
                    evmGas: 180_000n,
                    basis: "assumed",
                    note: "no sample: a Safe `execute` UserOp validated by the new OwnableValidator",
                },
            ];
    }
}

function solanaWork(operation: CostOperation, ctx: WorkContext): WorkStep[] {
    switch (operation) {
        case "protect": {
            const steps: WorkStep[] = [];
            if (!ctx.vaultExists) {
                steps.push({
                    label: "create_vault",
                    payer: "the relayer",
                    lamports: 10_000n,
                    // Rent, not a fee. The program's vault account is 553 bytes — the same size the
                    // discovery `dataSize` filter pins — and its deposit is returned if the account
                    // is ever closed, so it is totalled apart from money that is actually spent.
                    rentLamports: 3_459_480n,
                    basis: "measured",
                    note: "meta.fee and the rent credited on a real create_vault (devnet)",
                });
            }
            steps.push({
                label: "register (+ ed25519 verify)",
                payer: "the relayer",
                lamports: 15_000n,
                basis: "measured",
                note: "meta.fee on devnet — three charged signatures, not two",
            });
            return steps;
        }
        case "recover":
            return [
                {
                    label: "initiate_recovery (+ ed25519 verify)",
                    payer: "the relayer",
                    lamports: 15_000n,
                    basis: "measured",
                    note: "meta.fee on devnet",
                },
                {
                    label: "execute_recovery",
                    payer: "the relayer",
                    lamports: 10_000n,
                    basis: "assumed",
                    note: "no sample: two signers, no precompile",
                },
            ];
        case "move-funds":
            return [
                {
                    label: "execute_transfer",
                    payer: "the relayer",
                    lamports: 10_000n,
                    basis: "assumed",
                    note: "no sample: two signers, no precompile",
                },
            ];
    }
}
