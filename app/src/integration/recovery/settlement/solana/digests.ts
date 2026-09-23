/**
 * What a Solana signature commits to — bound to one cluster, never defaulted.
 *
 * **`digestsFor(cluster)` has no default, deliberately.** Each program build bakes in one cluster
 * tag and folds it into every digest; it stands in for the `block.chainid` an EVM contract gets for
 * free. A client that guessed would produce signatures the program silently rejects — not an error
 * naming the cause, a rejection. So the cluster is bound once, here, from the chain module that
 * knows which RPC it is actually talking to.
 *
 * The three digests and who signs them:
 *
 * | | signed by | binds |
 * |---|---|---|
 * | `registrationDigest` | the incoming guardian | program, vault, owner, guardian, veto fingerprint, `config_nonce` |
 * | `intentDigest` | the guardian | program, vault, epoch, nonce, new owner, owner config, expiry |
 * | `resumeDigest` | each quorum member | program, vault, intent digest, `attempt_seq` |
 *
 * `config_nonce` and `attempt_seq` are what make each signature spendable once. Without them an old
 * registration could be replayed to revert a rotation, and a banked resume endorsement could be
 * replayed onto a later attempt.
 *
 * **To replace:** nothing. **Assumes:** the program you are talking to was built for this cluster.
 * A localnet binary deployed to devnet produces digests nobody can match — check with
 * `strings <program>.so | grep nihilium-cluster:` before trusting a deployment.
 */
import { digestsFor, vetoFingerprint, type ClusterName } from "@nihilium/recovery-onchain-solana";

export type { ClusterName };

/** The clusters the program is built for. A string outside this set is a typo, not a network. */
const KNOWN: readonly ClusterName[] = ["localnet", "devnet", "mainnet-beta"];

export function clusterFromNamespace(namespace: string, declared: string): ClusterName {
    if (!KNOWN.includes(declared as ClusterName)) {
        throw new Error(
            `"${declared}" is not a cluster this program is built for (${KNOWN.join(", ")}). The ` +
                `cluster tag is folded into every digest, so a wrong one yields signatures the ` +
                `program rejects without saying why. Namespace was ${namespace}.`,
        );
    }
    return declared as ClusterName;
}

/**
 * The digest builders for one cluster.
 *
 * Returned as a unit rather than as three loose functions so a caller cannot accidentally mix a
 * devnet registration digest with a mainnet intent digest — they would each be individually valid
 * and jointly meaningless.
 */
export function solanaDigests(cluster: ClusterName) {
    return digestsFor(cluster);
}

export { vetoFingerprint };
