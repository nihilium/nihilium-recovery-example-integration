/**
 * The relayer: gas, and nothing else.
 *
 * `initiateRecovery` and `executeRecovery` are authorised by the **signature inside the intent**,
 * not by who sends the transaction. That is the whole reason this role can exist: a user who has
 * lost access to their account has, by definition, no funded key to pay with, and a recovery that
 * required one would fail in exactly the case it is built for.
 *
 * So this role holds one key, it pays, and it can do nothing else. It cannot alter an intent — any
 * edit invalidates the signature — it cannot start a recovery of its own, and it cannot stop one.
 * Refusing to send is the entirety of its power, and a second relayer defeats that.
 *
 * **It deliberately does not install the module.** Only an account can install its own module, so
 * `protect` and `rotate` are UserOps signed by the wallet. A route here that offered to do it would
 * be a route that cannot work.
 *
 * **To replace:** the transport. Whether this is Express, a queue or a Lambda changes nothing below
 * the two `writeContract` calls. **Assumes:** the caller has already run the preflight — this role
 * reports what the chain says but does not decide whether a recovery should be attempted.
 */
import { Router } from "express";
import {
    formatEther,
    getAddress,
    type Account,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { recoveryModuleAbi } from "@nihilium/recovery-onchain-evm";

/** Mirrors the module's `Intent` tuple. Positional — see `settlement/evm/vetoConfig.ts`. */
export interface IntentPayload {
    account: Address;
    epoch: string;
    nonce: string;
    newValidator: Address;
    newValidatorInitData: Hex;
    expiry: number;
}

export interface RelayerDeps {
    publicClient: PublicClient;
    walletClient: WalletClient;
    /**
     * The **account object**, never the address.
     *
     * viem decides how to send from this: an `Account` is signed locally and broadcast with
     * `eth_sendRawTransaction`, while a bare address is treated as a JSON-RPC account and sent with
     * `eth_sendTransaction` — asking the *node* to sign. A public endpoint holds no keys, so that
     * path dies with "unknown account", and the error names the RPC method rather than the cause.
     * The wallet client is already bound to this account; passing the address here silently
     * overrode it.
     */
    relayer: Account;
    moduleAddress: Address;
    /** Ceiling on `/fund`, so a demo faucet cannot be drained by a loop. */
    fundMaxWei: bigint;
    /** What the wallet needs in order to install the module itself. */
    vetoConfig: {
        pauseAuthority: Address;
        resumeMembers: Address[];
        resumeThreshold: number;
        timelockSeconds: number;
        pauseCeilingSeconds: number;
    };
    log?: (message: string) => void;
}

function toTuple(intent: IntentPayload) {
    return {
        account: getAddress(intent.account),
        epoch: BigInt(intent.epoch),
        nonce: BigInt(intent.nonce),
        newValidator: getAddress(intent.newValidator),
        newValidatorInitData: intent.newValidatorInitData,
        expiry: intent.expiry,
    };
}

export function createRelayerRouter(deps: RelayerDeps): Router {
    const router = Router();
    const note = deps.log ?? (() => undefined);

    /** Every write logs the state either side of it. A relayer that cannot be audited is a trusted one. */
    async function snapshot(account: Address) {
        // Types come off the generated ABI rather than a hand-written cast: a cast here would keep
        // compiling after a regenerated artifact changed the tuple underneath it.
        const [state, [intentHash, attempt]] = await Promise.all([
            deps.publicClient.readContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "stateOf",
                args: [account],
            }),
            deps.publicClient.readContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "attemptOf",
                args: [account],
            }),
        ]);
        return { state, intentHash, accruedSeconds: attempt.accruedSeconds.toString() };
    }

    /**
     * What the wallet needs to build its own install. The veto authorities are this operator's
     * choice, not the account's — only the timelock is per-account, and the wallet sends that.
     *
     * `abortAuthority` is deliberately absent: it is the wallet's own key, chosen by the wallet.
     */
    router.get("/config", (_req, res) => {
        res.json({
            recoveryModuleAddress: deps.moduleAddress,
            relayer: deps.relayer.address,
            pauseAuthority: deps.vetoConfig.pauseAuthority,
            resumeMembers: deps.vetoConfig.resumeMembers,
            resumeThreshold: deps.vetoConfig.resumeThreshold,
            timelockSeconds: deps.vetoConfig.timelockSeconds,
            pauseCeilingSeconds: deps.vetoConfig.pauseCeilingSeconds,
        });
    });

    router.post("/initiate", async (req, res) => {
        const { intent, signature } = req.body as { intent: IntentPayload; signature: Hex };
        if (!intent || !signature) {
            res.status(400).json({ error: "Both `intent` and `signature` are required." });
            return;
        }
        const account = getAddress(intent.account);
        try {
            const before = await snapshot(account);
            const hash = await deps.walletClient.writeContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "initiateRecovery",
                // Untouched. Any edit here invalidates the signature, which is the property that
                // makes it safe to hand an intent to a stranger with gas.
                args: [toTuple(intent), signature],
                account: deps.relayer,
                chain: deps.walletClient.chain,
            });
            await deps.publicClient.waitForTransactionReceipt({ hash });
            const after = await snapshot(account);
            note(`initiate ${account} ${JSON.stringify(before)} -> ${JSON.stringify(after)} tx=${hash}`);
            res.json({ hash, before, after });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    router.post("/execute", async (req, res) => {
        const { intent } = req.body as { intent: IntentPayload };
        if (!intent) {
            res.status(400).json({ error: "`intent` is required." });
            return;
        }
        const account = getAddress(intent.account);
        try {
            const before = await snapshot(account);
            // No signature: the module already holds the intent hash from `initiate`, and the
            // timelock — not a second signature — is what gates this call.
            const hash = await deps.walletClient.writeContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "executeRecovery",
                args: [toTuple(intent)],
                account: deps.relayer,
                chain: deps.walletClient.chain,
            });
            await deps.publicClient.waitForTransactionReceipt({ hash });
            const after = await snapshot(account);
            note(`execute ${account} ${JSON.stringify(before)} -> ${JSON.stringify(after)} tx=${hash}`);
            res.json({ hash, before, after });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    /**
     * A demo faucet, capped. It exists because an account with no ETH cannot install its own module,
     * and "go and find a Sepolia faucet" is where a reader stops reading.
     */
    router.post("/fund", async (req, res) => {
        const { to, wei } = req.body as { to: Address; wei?: string };
        if (!to) {
            res.status(400).json({ error: "`to` is required." });
            return;
        }
        const amount = wei === undefined ? deps.fundMaxWei : BigInt(wei);
        if (amount > deps.fundMaxWei) {
            res.status(400).json({
                error: `Capped at ${formatEther(deps.fundMaxWei)} ETH per request; asked for ${formatEther(amount)}.`,
            });
            return;
        }
        try {
            const hash = await deps.walletClient.sendTransaction({
                to: getAddress(to),
                value: amount,
                account: deps.relayer,
                chain: deps.walletClient.chain,
            });
            await deps.publicClient.waitForTransactionReceipt({ hash });
            note(`fund ${to} ${amount} wei tx=${hash}`);
            res.json({ hash, wei: amount.toString() });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    return router;
}

/**
 * A revert reason, or the closest thing to one.
 *
 * viem's `shortMessage` names the custom error — `AttemptInFlight`, `WrongEpoch` — where the full
 * message buries it under the request body. Returning the whole thing to a browser is how a demo
 * ends up rendering a page of hex.
 */
/**
 * What actually went wrong, in enough detail to act on.
 *
 * `shortMessage` alone is how a relayer failure reaches the screen as "Invalid parameters were
 * provided to the RPC method" — true, unhelpful, and naming neither the method nor the parameter.
 * viem puts that in `metaMessages` and `details`, so they go too: an error a user can only
 * screenshot is an error nobody can fix.
 */
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
