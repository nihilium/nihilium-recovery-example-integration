/**
 * The relayer, on Arbitrum Sepolia: gas for an EOA that delegates to `Eip7702RecoveryAccount`.
 *
 * Same party as the relayers beside it and the same non-capabilities. Every route here submits a call
 * whose authority is a signature the relayer cannot forge: `initiateRecovery` is signed by the
 * recovered key, `executeRecovery` is gated by the timelock, and `execute` is signed by the account's
 * current owner. Any edit to what it is handed invalidates that signature, so refusing to send is
 * the whole of its power.
 *
 * **Every call is sent to the EOA's own address.** The account is the contract; there is no module
 * address to aim at. The implementation address is published in `/config` only so a client can check
 * what the account should be delegated to.
 *
 * **It never delegates or registers.** A 7702 authorization must be signed by the EOA's own key, and
 * `register` needs the owner's consent. Those are the wallet's transactions, and a route here
 * offering either would be a route that cannot work.
 *
 * **To replace:** the transport. **Assumes:** the caller ran its own preflight. This role reports
 * what the chain says and does not decide whether a recovery should be attempted.
 */
import { Router } from "express";
import {
    getAddress,
    isAddress,
    isHex,
    type Account,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { eip7702RecoveryAccountAbi } from "@nihilium/recovery-onchain-evm";

/** The contract's `Intent`, as JSON carries it. `account` names the EOA it is sent to. */
export interface Eip7702IntentPayload {
    account: string;
    epoch: string;
    nonce: string;
    newOwner: string;
    expiry: number;
}

export interface Eip7702CallPayload {
    target: string;
    /** Wei, as a decimal string: `bigint` does not survive JSON. */
    value: string;
    data: string;
}

export interface Eip7702RelayerDeps {
    publicClient: PublicClient;
    walletClient: WalletClient;
    /** The account object, never the address. See `index.ts` for why that distinction bites. */
    relayer: Account;
    implementation: Address;
    vetoConfig: {
        pauseAuthority: Address;
        resumeMembers: Address[];
        resumeThreshold: number;
        timelockSeconds: number;
        pauseCeilingSeconds: number;
    };
    log?: (message: string) => void;
}

/** Thrown for a malformed request, so it answers 400 rather than looking like a chain failure. */
class BadRequest extends Error {}

function address(value: unknown, field: string): Address {
    if (typeof value !== "string" || !isAddress(value)) throw new BadRequest(`\`${field}\` is not an address.`);
    return getAddress(value);
}

function hex(value: unknown, field: string): Hex {
    if (typeof value !== "string" || !isHex(value)) throw new BadRequest(`\`${field}\` is not hex.`);
    return value;
}

function uint(value: unknown, field: string): bigint {
    if (typeof value !== "string" && typeof value !== "number") {
        throw new BadRequest(`\`${field}\` is required.`);
    }
    try {
        const parsed = BigInt(value);
        if (parsed < 0n) throw new Error();
        return parsed;
    } catch {
        throw new BadRequest(`\`${field}\` is not a non-negative integer.`);
    }
}

function expiryOf(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new BadRequest(`\`${field}\` is not a unix time in seconds.`);
    }
    return value;
}

export function parseIntent(body: unknown): { account: Address; intent: {
    epoch: bigint;
    nonce: bigint;
    newOwner: Address;
    expiry: number;
} } {
    const intent = (body as { intent?: Eip7702IntentPayload } | undefined)?.intent;
    if (intent === undefined || intent === null) throw new BadRequest("`intent` is required.");
    return {
        account: address(intent.account, "intent.account"),
        intent: {
            epoch: uint(intent.epoch, "intent.epoch"),
            nonce: uint(intent.nonce, "intent.nonce"),
            newOwner: address(intent.newOwner, "intent.newOwner"),
            expiry: expiryOf(intent.expiry, "intent.expiry"),
        },
    };
}

export function parseExecuteCalls(body: unknown): {
    account: Address;
    calls: { target: Address; value: bigint; data: Hex }[];
    expiry: number;
    signature: Hex;
} {
    const request = (body ?? {}) as {
        account?: unknown;
        calls?: unknown;
        expiry?: unknown;
        signature?: unknown;
    };
    if (!Array.isArray(request.calls) || request.calls.length === 0) {
        throw new BadRequest("`calls` must be a non-empty list.");
    }
    return {
        account: address(request.account, "account"),
        calls: (request.calls as Eip7702CallPayload[]).map((call, i) => ({
            target: address(call?.target, `calls[${i}].target`),
            value: uint(call?.value, `calls[${i}].value`),
            data: hex(call?.data, `calls[${i}].data`),
        })),
        expiry: expiryOf(request.expiry, "expiry"),
        signature: hex(request.signature, "signature"),
    };
}

export function createEip7702RelayerRouter(deps: Eip7702RelayerDeps): Router {
    const router = Router();
    const note = deps.log ?? (() => undefined);

    async function snapshot(account: Address) {
        const [state, [intentHash]] = await Promise.all([
            deps.publicClient.readContract({
                address: account,
                abi: eip7702RecoveryAccountAbi,
                functionName: "stateOf",
            }),
            deps.publicClient.readContract({
                address: account,
                abi: eip7702RecoveryAccountAbi,
                functionName: "attemptOf",
            }),
        ]);
        return { state, intentHash };
    }

    async function send(
        res: import("express").Response,
        label: string,
        account: Address,
        write: () => Promise<Hex>,
    ): Promise<void> {
        try {
            const before = await snapshot(account);
            const hash = await write();
            const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success") {
                res.status(502).json({ error: `${label} reverted in ${hash}.` });
                return;
            }
            const after = await snapshot(account);
            note(`${label} ${account} ${JSON.stringify(before)} -> ${JSON.stringify(after)} tx=${hash}`);
            res.json({ hash });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    }

    function guarded(
        handler: (req: import("express").Request, res: import("express").Response) => Promise<void>,
    ) {
        return async (req: import("express").Request, res: import("express").Response) => {
            try {
                await handler(req, res);
            } catch (error) {
                if (error instanceof BadRequest) {
                    res.status(400).json({ error: error.message });
                    return;
                }
                res.status(502).json({ error: reasonOf(error) });
            }
        };
    }

    /**
     * The operator's veto keys on this chain, and the implementation to delegate to.
     * `abortAuthority` is absent on purpose: it is the wallet's own key, chosen by the wallet.
     */
    router.get("/config", (_req, res) => {
        res.json({
            implementation: deps.implementation,
            relayer: deps.relayer.address,
            ...deps.vetoConfig,
        });
    });

    router.post(
        "/initiate",
        guarded(async (req, res) => {
            const { account, intent } = parseIntent(req.body);
            const signature = hex((req.body as { signature?: unknown }).signature, "signature");
            await send(res, "initiate", account, () =>
                deps.walletClient.writeContract({
                    address: account,
                    abi: eip7702RecoveryAccountAbi,
                    functionName: "initiateRecovery",
                    // Untouched: any edit invalidates the signature.
                    args: [intent, signature],
                    account: deps.relayer,
                    chain: deps.walletClient.chain,
                }),
            );
        }),
    );

    router.post(
        "/execute",
        guarded(async (req, res) => {
            const { account, intent } = parseIntent(req.body);
            await send(res, "execute", account, () =>
                deps.walletClient.writeContract({
                    address: account,
                    abi: eip7702RecoveryAccountAbi,
                    functionName: "executeRecovery",
                    args: [intent],
                    account: deps.relayer,
                    chain: deps.walletClient.chain,
                }),
            );
        }),
    );

    /**
     * The recovered owner's calls, submitted and paid for. Value comes out of the account's own
     * balance, never the relayer's: `execute` is not sent with any.
     */
    router.post(
        "/execute-calls",
        guarded(async (req, res) => {
            const { account, calls, expiry, signature } = parseExecuteCalls(req.body);
            await send(res, "execute-calls", account, () =>
                deps.walletClient.writeContract({
                    address: account,
                    abi: eip7702RecoveryAccountAbi,
                    functionName: "execute",
                    args: [calls, expiry, signature],
                    account: deps.relayer,
                    chain: deps.walletClient.chain,
                }),
            );
        }),
    );

    return router;
}

/** A revert reason, or the closest thing to one. See `index.ts#reasonOf`. */
function reasonOf(error: unknown): string {
    if (typeof error !== "object" || error === null) {
        return error instanceof Error ? error.message : String(error);
    }
    const viem = error as { shortMessage?: unknown; metaMessages?: unknown; details?: unknown };
    if (viem.shortMessage === undefined) {
        return error instanceof Error ? error.message : String(error);
    }
    const parts = [String(viem.shortMessage)];
    if (Array.isArray(viem.metaMessages)) parts.push(...viem.metaMessages.map(String));
    if (typeof viem.details === "string" && viem.details.length > 0) parts.push(viem.details);
    return parts.join(" | ");
}
