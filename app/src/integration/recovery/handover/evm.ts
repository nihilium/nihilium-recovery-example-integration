/**
 * Moving a recovered Safe: submit the intent, wait, install the validator, send the balance on.
 *
 * Plain functions rather than a hook, because the three steps do not happen in one sitting. The
 * timelock sits between the first and the second and can outlast the browser session, so the code
 * that drives them has to be callable from wherever the user comes back to — and a hook can only be
 * called from a render.
 *
 * **What `executeRecovery` actually does on EVM, and why the sweep is separate.** It installs an
 * `OwnableValidator` owned by the intent's `newOwner`. It removes nothing: the Safe's own owner list
 * is untouched and the key that was lost can still act through `execTransaction`, entirely outside
 * ERC-7579. So taking control back does not take it away from anyone, and moving the balance
 * somewhere the old key cannot reach is a second, separate act.
 *
 * **To replace:** the relayer POSTs, if yours lives elsewhere. Nothing above this knows it is HTTP.
 * **Assumes:** the module at `recoveryModuleAddress(chainId)` is the one this account installed, and
 * that `intent` reaches `execute` byte-identical — it is re-hashed there and compared.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoveryModuleAbi, recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { buildIntent, DEFAULT_INTENT_TTL_SECONDS } from "../settlement/evm/intent.js";
import { createModuleReader, type SolidityIntent } from "../settlement/evm/reads.js";
import { preflightRecovery } from "../settlement/evm/preflight.js";
import { sendAsRecoveredOwner } from "../settlement/evm/recoveredOwner.js";
import type {
    AbortParams,
    ChainHandover,
    ExecuteParams,
    InitiateParams,
    InitiateResult,
    SweepParams,
    SweepResult,
} from "./types.js";

export interface EvmHandoverConfig {
    chainId: number;
    rpcUrl: string;
    bundlerUrl: string;
}

/**
 * What must stay in the account, in wei.
 *
 * A smart account pays for its own UserOp out of the balance it is sending, and validation runs
 * *before* the transfer — so sweeping the whole balance is rejected for insufficient funds after the
 * user has been told the amount was fine. This is the difference between a sweep that works and one
 * that fails every time. Generous rather than tuned: over-reserving leaves dust behind, and
 * under-reserving leaves the funds where they were.
 */
export const SWEEP_RESERVE_WEI = 3_000_000_000_000_000n;

export function createEvmHandover(config: EvmHandoverConfig): ChainHandover {
    const client = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
    const reader = () =>
        createModuleReader(
            client,
            recoveryModuleAddress(config.chainId) as Address,
            `eip155:${config.chainId}`,
        );

    return {
        async preflight({ chainRecord }) {
            const expected = chainRecord.recoveryPubKeyHex;
            if (expected === undefined) {
                return [
                    {
                        code: "no-recovery-key",
                        blocking: true,
                        message: "This vault recorded no recovery key for this account.",
                    },
                ];
            }
            // The same checks `initiate` repeats, minus the relayer: whether it is funded is a
            // fact about the moment of submitting, not about whether this account can be recovered.
            return preflightRecovery(reader(), {
                account: chainRecord.accountId as Address,
                expectedRecoveryPubKeyHex: expected,
                intentTtlSeconds: DEFAULT_INTENT_TTL_SECONDS,
            });
        },

        async initiate(params: InitiateParams): Promise<InitiateResult> {
            const module = reader();
            const account = params.chainRecord.accountId as Address;

            // Before anything is signed: the module installed, the epoch matching, no attempt
            // already in flight, the intent outliving the timelock.
            const expected = params.chainRecord.recoveryPubKeyHex;
            if (expected === undefined) {
                // Without it there is nothing to check the module's answer against.
                throw new Error(
                    `Vault record has no registered recovery key for ${account}.`,
                );
            }
            const problems = await preflightRecovery(module, {
                account,
                expectedRecoveryPubKeyHex: expected,
                intentTtlSeconds: DEFAULT_INTENT_TTL_SECONDS,
            });
            const blocking = problems.find((problem) => problem.blocking);
            if (blocking !== undefined) throw new Error(blocking.message);

            const config_ = await module.configOf(account);
            params.onProgress?.(`configOf   epoch=${config_.epoch} nonce=${config_.nonce}`);

            const { solidity } = buildIntent({
                account,
                newOwner: params.newOwner as Address,
                epoch: config_.epoch,
                nonce: config_.nonce,
                moduleAddress: module.moduleAddress,
            });

            // Read, never computed: the deployment's `version()` differs from the checked-out
            // Solidity, and that string is inside the EIP-712 domain separator.
            const digest = await module.hashIntent(solidity);
            params.onProgress?.(`hashIntent ${digest}`);

            const signature = await params.keyAdapter.sign(params.material, hexToBytes(digest));
            params.onProgress?.(`signed     by the recovered key, ${signature.bytes.length} bytes`);

            const result = await post(params.serverUrl, "initiate", {
                intent: serialize(solidity),
                signature: `0x${toHex(signature.bytes)}`,
            });
            params.onProgress?.(`initiate   tx=${result.hash}`);
            // Serialized, because this is going into IndexedDB and `bigint` does not survive
            // structured cloning through JSON on the way back out of the relayer's shape.
            return { intent: serialize(solidity), hash: String(result.hash) };
        },

        async execute(params: ExecuteParams): Promise<{ hash: string }> {
            // No signature. By now the timelock is the authority, which is what lets this run in a
            // session that never held the recovered key.
            const result = await post(params.serverUrl, "execute", { intent: params.intent });
            params.onProgress?.(`execute    tx=${result.hash} — validator installed, epoch bumped`);
            return { hash: String(result.hash) };
        },

        async abort(params: AbortParams): Promise<{ hash: string }> {
            // Sent by the abort authority itself, not the relayer. `abort` checks `msg.sender`,
            // which is exactly what makes it a backstop against a rogue provider — and exactly why
            // this key has to hold gas, unlike initiate and execute.
            const account = privateKeyToAccount(params.authorityPrivateKeyHex as Hex);
            const wallet = createWalletClient({
                account,
                chain: sepolia,
                transport: http(config.rpcUrl),
            });
            params.onProgress?.(`abort      as ${account.address}`);
            const hash = await wallet.writeContract({
                address: recoveryModuleAddress(config.chainId) as Address,
                abi: recoveryModuleAbi,
                functionName: "abort",
                args: [params.chainRecord.accountId as Address],
                chain: sepolia,
            });
            await client.waitForTransactionReceipt({ hash });
            params.onProgress?.(`abort      tx=${hash} — terminal`);
            return { hash };
        },

        async sweep(params: SweepParams): Promise<SweepResult> {
            const account = params.chainRecord.accountId as Address;
            const balance = await client.getBalance({ address: account });
            const moved =
                params.amount ??
                (balance > SWEEP_RESERVE_WEI ? balance - SWEEP_RESERVE_WEI : 0n);

            if (moved <= 0n) {
                // Control has moved and the balance is reachable; the account just cannot pay to move itself.
                throw new Error(
                    `Balance of ${balance} wei is too low to pay its own fee. ` +
                        `Send a little ETH to ${account} and move again.`,
                );
            }

            const receipt = await sendAsRecoveredOwner({
                rpcUrl: config.rpcUrl,
                bundlerUrl: config.bundlerUrl,
                account,
                newOwnerPrivateKeyHex: params.ownerPrivateKeyHex,
                to: params.to as Address,
                amount: moved,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
            });
            return { hash: receipt.transactionHash, moved };
        },
    };
}

/** `bigint` is not JSON. One place, so the relayer and IndexedDB see the same shape. */
function serialize(intent: SolidityIntent): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(intent).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
        ]),
    );
}

async function post(
    serverUrl: string,
    route: string,
    body: unknown,
): Promise<{ hash: string }> {
    const response = await fetch(`${serverUrl}/api/roles/relayer/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as { hash?: string; error?: string };
    if (!response.ok) {
        // The relayer holds the gas: an account that has lost its key has nothing to pay with.
        throw new Error(
            parsed.error ??
                `Relayer refused (HTTP ${response.status}).`,
        );
    }
    return { hash: parsed.hash ?? "" };
}

function hexToBytes(hex: Hex): Uint8Array {
    const clean = hex.slice(2);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
