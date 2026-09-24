/**
 * The provider's half of the graduated veto: pause, and resume by quorum.
 *
 * Two powers that must not sit on one key, and here they do not — each has its own wallet client,
 * pre-bound at construction, so a route cannot reach the other's key even by mistake. That is
 * deliberately structural rather than a convention: three veto roles on one key looks correctly
 * configured and is worthless, and a code comment asking a future route to be careful is not a
 * control.
 *
 * **Abort is not here.** In this demo the abort authority is the wallet's own active EOA, signed in
 * the browser, so that an owner who still holds their keys can kill a recovery started against them.
 * That choice has a cost the SDK is explicit about and this repo does not hide: the abort key is
 * then seed-derived, so in the true-seed-loss case — the one recovery exists for — it is gone. See
 * `app/src/integration/recovery/settlement/evm/vetoConfig.ts`.
 *
 * **What one operator holding the whole resume quorum really buys.** The three resume members below
 * are three keys from one mnemonic on one server. The SDK describes the resume quorum as "slow,
 * plural, independent guardians"; these are plural in key material and in nothing else. Whoever
 * holds this process holds the quorum. `validateVetoConfig` cannot see it, because the keys do
 * genuinely differ — which is exactly why it is written here instead.
 *
 * **To replace:** all of it, if the resume members are real third parties. Then this role collects
 * signatures it did not produce, and the shape below — sign locally, submit together — becomes
 * "gather from k endpoints, submit together". The contract call is identical either way.
 * **Assumes:** each `resumeSigners` entry can sign the deployed `resumeDigest()` for the account.
 */
import { Router } from "express";
import {
    getAddress,
    type Account,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { recoveryModuleAbi } from "@nihilium/recovery-onchain-evm";

export interface VetoDeps {
    publicClient: PublicClient;
    moduleAddress: Address;
    /**
     * Pre-bound to the pause key, and only the pause key.
     *
     * The **account object**, never the address: viem signs an `Account` locally, and treats a bare
     * address as a JSON-RPC account it asks the node to sign for — which a public endpoint refuses
     * with "unknown account", naming the RPC method rather than the cause.
     */
    pause: { client: WalletClient; account: Account };
    /**
     * The resume quorum, in order. Signing happens with these; submitting happens with whichever
     * wallet the route is given, because `resume` checks the signatures, not the sender.
     */
    resume: { signers: Account[]; submitter: { client: WalletClient; account: Account } };
    resumeThreshold: number;
    log?: (message: string) => void;
}

export function createVetoRouter(deps: VetoDeps): Router {
    const router = Router();
    const note = deps.log ?? (() => undefined);

    router.post("/pause", async (req, res) => {
        const { account } = req.body as { account: Address };
        if (!account) {
            res.status(400).json({ error: "`account` is required." });
            return;
        }
        try {
            const hash = await deps.pause.client.writeContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "pause",
                args: [getAddress(account)],
                account: deps.pause.account,
                chain: deps.pause.client.chain,
            });
            await deps.publicClient.waitForTransactionReceipt({ hash });
            note(`pause ${account} tx=${hash}`);
            // A pause stops the clock; it does not stop the recovery. The ceiling lifts it again
            // with no transaction from anyone, which is what bounds this key's power.
            res.json({ hash, note: "The timelock clock is stopped until resume, or until the ceiling." });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    router.post("/resume", async (req, res) => {
        const { account } = req.body as { account: Address };
        if (!account) {
            res.status(400).json({ error: "`account` is required." });
            return;
        }
        try {
            const target = getAddress(account);
            const [intentHash] = (await deps.publicClient.readContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "attemptOf",
                args: [target],
            })) as [Hex, unknown];

            // Read, never derived. The deployment answers version "2.0.0" while the checked-out
            // Solidity answers "3.0.0", and the version is inside the EIP-712 domain separator.
            const digest = (await deps.publicClient.readContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "resumeDigest",
                args: [target, intentHash],
            })) as Hex;

            // Exactly the threshold, not everyone available: the contract counts distinct signers and
            // a redundant one is a guardian dragged through a signature nobody needed.
            const quorum = deps.resume.signers.slice(0, deps.resumeThreshold);
            const signatures = await Promise.all(
                quorum.map((signer) => signer.signMessage!({ message: { raw: digest } })),
            );

            const hash = await deps.resume.submitter.client.writeContract({
                address: deps.moduleAddress,
                abi: recoveryModuleAbi,
                functionName: "resume",
                args: [target, quorum.map((s) => getAddress(s.address)), signatures],
                account: deps.resume.submitter.account,
                chain: deps.resume.submitter.client.chain,
            });
            await deps.publicClient.waitForTransactionReceipt({ hash });
            note(`resume ${account} by ${quorum.length} of ${deps.resume.signers.length} tx=${hash}`);
            res.json({
                hash,
                signers: quorum.map((s) => s.address),
                note: "One operator holds all of these keys. The plurality is in the key material, not in who controls it.",
            });
        } catch (error) {
            res.status(502).json({ error: reasonOf(error) });
        }
    });

    return router;
}

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
