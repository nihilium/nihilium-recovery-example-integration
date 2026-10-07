/**
 * Protecting an Arbitrum EOA: delegate its code once, then register a recovery key on it.
 *
 * **Two transactions, and the split is forced.** `register` takes two signatures over
 * `hashRegister(reg)`, and that digest is read from the account, never built locally (see
 * `reads.ts`). Before the delegation lands there is no code at the EOA to answer the read. So the
 * first transaction only delegates: a type-4 transaction from the EOA to itself, whose calldata is a
 * harmless view so it cannot revert. The second registers.
 *
 * **Both signatures are real consent.** The recovery key signs to prove it exists and is held by
 * whoever registers it. The account's current owner, the EOA itself until a recovery executes,
 * signs so that nobody can bind a recovery key to an account that did not agree. A single-signature
 * design would let anyone front-run the registration.
 *
 * The wallet pays for both. It holds funds, or Protect all would not be offering this chain, and a
 * self-sponsored authorization keeps the relayer out of the one step that must be the owner's.
 *
 * **To replace:** the private-key handling: `ownerPrivateKeyHex` is the demo's escape hatch. A real
 * wallet signs the authorization and the digest through its own signer. **Assumes:** `preflight.ts`
 * has already passed `preflightProtect`, so the implementation can receive ETH and the EOA is not
 * delegated to anyone else's code.
 */
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    getAddress,
    hexToBytes,
    http,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { eip7702RecoveryAccountAbi } from "@nihilium/recovery-onchain-evm";
import type { SolidityVetoConfig } from "../evm/vetoConfig.js";
import { createEip7702Reader, type Eip7702Reader } from "./reads.js";
import { preflightProtect } from "./preflight.js";

export interface Eip7702ProtectConfig {
    rpcUrl: string;
    implementation: Address;
    namespace: string;
    /** The EOA's own key. It signs the authorization, both transactions and the owner half of `register`. */
    ownerPrivateKeyHex: Hex;
}

export interface Eip7702ProtectParams {
    recoveryOwner: Address;
    veto: SolidityVetoConfig;
    /**
     * Signs a 32-byte digest with the incoming recovery key.
     *
     * A callback rather than key bytes: the key is minted, used for this one signature and wiped by
     * the caller, and this file never holds it.
     */
    signAsRecoveryKey(digest: Uint8Array): Promise<Uint8Array>;
    onProgress?(message: string): void;
}

/** The pieces the caller needs before it can mint anything. */
export interface Eip7702Session {
    reader: Eip7702Reader;
    /** Delegate if needed, then register. Throws with the reason. */
    protect(params: Eip7702ProtectParams): Promise<{ delegationTx: Hex | null; registerTx: Hex }>;
}

export function openEip7702Session(config: Eip7702ProtectConfig): Eip7702Session {
    const owner = privateKeyToAccount(config.ownerPrivateKeyHex);
    const client = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(config.rpcUrl),
    }) as PublicClient;
    const wallet = createWalletClient({
        account: owner,
        chain: arbitrumSepolia,
        transport: http(config.rpcUrl),
    });
    const reader = createEip7702Reader(client, owner.address, config.implementation, config.namespace);

    async function confirm(hash: Hex, what: string): Promise<void> {
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`${what} reverted in ${hash}.`);
    }

    return {
        reader,

        async protect(params) {
            const note = params.onProgress ?? (() => undefined);

            // Refused before the authorization is signed: neither of these can be undone by an owner
            // who has lost their key.
            const refusal = (await preflightProtect(reader)).find((problem) => problem.blocking);
            if (refusal !== undefined) throw new Error(refusal.message);

            let delegationTx: Hex | null = null;
            const delegation = await reader.delegation();
            // A superseded version of ours is re-delegated: that is the upgrade. Every version keeps
            // its state in the same ERC-7201 slot with the same field order, so the registration and
            // its nonces carry over, and `register` below rotates the key on the new code.
            if (delegation.kind === "legacy") {
                note(`upgrade    v${delegation.version} (${delegation.target}) -> ${config.implementation}`);
            }
            if (delegation.kind === "none" || delegation.kind === "legacy") {
                // `executor: "self"`: the sender is the authority, so the authorization must carry
                // the nonce *after* this transaction's own. viem does that arithmetic.
                const authorization = await wallet.signAuthorization({
                    contractAddress: config.implementation,
                    executor: "self",
                });
                note(`authorize  ${owner.address} -> ${config.implementation}`);
                delegationTx = await wallet.sendTransaction({
                    authorizationList: [authorization],
                    to: owner.address,
                    // A view, so the call the delegation rides on cannot revert. The authorization
                    // would persist even if it did, but a failed transaction is a confusing receipt.
                    data: encodeFunctionData({
                        abi: eip7702RecoveryAccountAbi,
                        functionName: "isRegistered",
                    }),
                });
                await confirm(delegationTx, "The delegation");
                note(`delegate   tx=${delegationTx}`);
            } else {
                note(`delegate   already at ${config.implementation}`);
            }

            const current = await reader.configOf();
            // After a recovery the owner is somebody else, and this key's signature no longer counts.
            if (getAddress(current.currentOwner) !== getAddress(owner.address)) {
                throw new Error(
                    `This account was recovered; its owner is now ${current.currentOwner}. ` +
                        "Only that key can change its recovery key.",
                );
            }

            const reg = {
                recoveryOwner: params.recoveryOwner,
                veto: params.veto,
                // `configNonce`, never the recovery nonce: it makes this registration spendable once,
                // so an old one cannot be replayed to undo a later rotation.
                nonce: current.configNonce,
            };
            const digest = await reader.hashRegister(reg);
            note(`hashRegister ${digest} (configNonce ${current.configNonce})`);

            const recoverySignature = await params.signAsRecoveryKey(hexToBytes(digest));
            const ownerSignature = await owner.sign({ hash: digest });

            const registerTx = await wallet.writeContract({
                address: owner.address,
                abi: eip7702RecoveryAccountAbi,
                functionName: "register",
                args: [reg, toHex(recoverySignature), ownerSignature],
            });
            await confirm(registerTx, "The registration");
            note(`register   tx=${registerTx}`);
            return { delegationTx, registerTx };
        },
    };
}

function toHex(bytes: Uint8Array): Hex {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
