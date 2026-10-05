/**
 * Moving a recovered Arbitrum EOA: submit the intent, wait, rotate the owner, send the balance on.
 *
 * The same three steps as `evm.ts`, against an account that is its own contract. Every call goes to
 * the EOA's address, and the relayer submits all of them. `initiateRecovery`, `executeRecovery`
 * and `execute` each carry their authority in a signature or in the timelock, never in the sender.
 *
 * **What `executeRecovery` does here.** It sets the account's stored `owner` to the intent's
 * `newOwner`. From then on only that key's signatures pass `execute` and `register`. It does not,
 * and cannot, stop the EOA's original key from sending ordinary transactions: a protocol-level key
 * is outside any contract's reach. That is the loss-not-theft line in its plainest form. Recovery
 * restores access to an owner who lost the key; it does not defend an account whose key someone
 * else holds.
 *
 * **The sweep keeps nothing back.** The new owner signs `hashExecute`, the relayer submits and pays
 * the gas, and the value comes out of the EOA's own balance. There is no prefund to reserve for,
 * unlike the Safe path.
 *
 * **To replace:** the relayer POSTs, if yours lives elsewhere. **Assumes:** `intent` reaches
 * `execute` byte-identical to what `initiate` submitted, and the destination can receive ETH. A
 * fresh EOA can; a contract without `receive()` cannot.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { eip7702AccountAddress, eip7702RecoveryAccountAbi } from "@nihilium/recovery-onchain-evm";
import { ARBITRUM_SEPOLIA_CHAIN_ID } from "../../chains/arbitrumSepolia.js";
import { DEFAULT_INTENT_TTL_SECONDS } from "../settlement/evm/intent.js";
import { createEip7702Reader, type Eip7702Intent } from "../settlement/eip7702/reads.js";
import { preflightRecovery } from "../settlement/eip7702/preflight.js";
import type {
    AbortParams,
    ChainHandover,
    ExecuteParams,
    InitiateParams,
    InitiateResult,
    SweepParams,
    SweepResult,
} from "./types.js";

export interface Eip7702HandoverConfig {
    rpcUrl: string;
    /** Where the relayer's Arbitrum routes are mounted, relative to the server. */
    relayerPath?: string;
}

/** How long an `execute` signature stays valid. Short: it is submitted the moment it is made. */
const EXECUTE_TTL_SECONDS = 600;

/** The intent as it crosses JSON and sits in IndexedDB. `account` rides along for the relayer. */
export interface SerializedEip7702Intent {
    account: Address;
    epoch: string;
    nonce: string;
    newOwner: Address;
    expiry: number;
}

export function createEip7702Handover(config: Eip7702HandoverConfig): ChainHandover {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(config.rpcUrl) });
    const namespace = `eip155:${ARBITRUM_SEPOLIA_CHAIN_ID}`;
    const implementation = eip7702AccountAddress(ARBITRUM_SEPOLIA_CHAIN_ID) as Address;
    const readerFor = (account: string) =>
        createEip7702Reader(client, account as Address, implementation, namespace);
    const route = config.relayerPath ?? "/api/roles/relayer/arbitrum";

    async function post(serverUrl: string, path: string, body: unknown): Promise<{ hash: string }> {
        const response = await fetch(`${serverUrl}${route}/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const parsed = (await response.json().catch(() => ({}))) as { hash?: string; error?: string };
        if (!response.ok) throw new Error(parsed.error ?? `Relayer refused (HTTP ${response.status}).`);
        return { hash: parsed.hash ?? "" };
    }

    return {
        async preflight({ chainRecord }) {
            if (chainRecord.recoveryPubKeyHex === undefined) {
                return [
                    {
                        code: "no-recovery-key",
                        blocking: true,
                        message: "This vault recorded no recovery key for this account.",
                    },
                ];
            }
            return preflightRecovery(readerFor(chainRecord.accountId), {
                expectedRecoveryPubKeyHex: chainRecord.recoveryPubKeyHex,
                intentTtlSeconds: DEFAULT_INTENT_TTL_SECONDS,
            });
        },

        async initiate(params: InitiateParams): Promise<InitiateResult> {
            const account = params.chainRecord.accountId as Address;
            const reader = readerFor(account);
            const expected = params.chainRecord.recoveryPubKeyHex;
            if (expected === undefined) {
                throw new Error(`Vault record has no registered recovery key for ${account}.`);
            }
            const blocking = (
                await preflightRecovery(reader, {
                    expectedRecoveryPubKeyHex: expected,
                    intentTtlSeconds: DEFAULT_INTENT_TTL_SECONDS,
                })
            ).find((problem) => problem.blocking);
            if (blocking !== undefined) throw new Error(blocking.message);

            const current = await reader.configOf();
            params.onProgress?.(`configOf   epoch=${current.epoch} nonce=${current.nonce}`);

            const intent: Eip7702Intent = {
                epoch: current.epoch,
                nonce: current.nonce,
                newOwner: params.newOwner as Address,
                expiry: Math.floor(Date.now() / 1000) + DEFAULT_INTENT_TTL_SECONDS,
            };
            // Read at the EOA, never computed: `verifyingContract` is the EOA and `version()` is in
            // the domain.
            const digest = await reader.hashIntent(intent);
            params.onProgress?.(`hashIntent ${digest}`);

            const signature = await params.keyAdapter.sign(params.material, hexToBytes(digest));
            params.onProgress?.(`signed     by the recovered key, ${signature.bytes.length} bytes`);

            const serialized = serialize(account, intent);
            const result = await post(params.serverUrl, "initiate", {
                intent: serialized,
                signature: toHex(signature.bytes),
            });
            params.onProgress?.(`initiate   tx=${result.hash}`);
            return { intent: serialized, hash: result.hash };
        },

        async execute(params: ExecuteParams): Promise<{ hash: string }> {
            const result = await post(params.serverUrl, "execute", { intent: params.intent });
            params.onProgress?.(`execute    tx=${result.hash} — owner rotated, epoch bumped`);
            return { hash: result.hash };
        },

        async sweep(params: SweepParams): Promise<SweepResult> {
            const account = params.chainRecord.accountId as Address;
            const reader = readerFor(account);
            const newOwner = privateKeyToAccount(params.ownerPrivateKeyHex as Hex);

            // Checked rather than assumed: a signature from anyone but the current owner reverts,
            // and "BadSignature" says nothing about the execute that has not landed yet.
            const current = await reader.configOf();
            if (current.currentOwner.toLowerCase() !== newOwner.address.toLowerCase()) {
                throw new Error(
                    `This account's owner is still ${current.currentOwner}. Execute the recovery first.`,
                );
            }

            const balance = await reader.balance();
            const moved = params.amount ?? balance;
            if (moved <= 0n) throw new Error(`${account} holds nothing to move.`);

            const calls = [{ target: params.to as Address, value: moved, data: "0x" as Hex }];
            const expiry = Math.floor(Date.now() / 1000) + EXECUTE_TTL_SECONDS;
            const digest = await reader.hashExecute(calls, expiry);
            const signature = await newOwner.sign({ hash: digest });
            params.onProgress?.(`hashExecute ${digest} — signed by the new owner`);

            const result = await post(params.serverUrl, "execute-calls", {
                account,
                calls: calls.map((call) => ({ ...call, value: call.value.toString() })),
                expiry,
                signature,
            });
            params.onProgress?.(`sweep      tx=${result.hash} — ${moved} wei to ${params.to}`);
            return { hash: result.hash, moved };
        },

        async abort(params: AbortParams): Promise<{ hash: string }> {
            // From the abort authority itself, to the account's own address. `abort()` checks the
            // sender, so the relayer cannot do this, and the key pays its own gas.
            const authority = privateKeyToAccount(params.authorityPrivateKeyHex as Hex);
            const wallet = createWalletClient({
                account: authority,
                chain: arbitrumSepolia,
                transport: http(config.rpcUrl),
            });
            params.onProgress?.(`abort      as ${authority.address}`);
            const hash = await wallet.writeContract({
                address: params.chainRecord.accountId as Address,
                abi: eip7702RecoveryAccountAbi,
                functionName: "abort",
            });
            await client.waitForTransactionReceipt({ hash });
            params.onProgress?.(`abort      tx=${hash} — terminal`);
            return { hash };
        },
    };
}

function serialize(account: Address, intent: Eip7702Intent): SerializedEip7702Intent {
    return {
        account,
        epoch: intent.epoch.toString(),
        nonce: intent.nonce.toString(),
        newOwner: intent.newOwner,
        expiry: intent.expiry,
    };
}

function hexToBytes(hex: Hex): Uint8Array {
    const clean = hex.slice(2);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function toHex(bytes: Uint8Array): Hex {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
