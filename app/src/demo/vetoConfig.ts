/**
 * This demo's veto configuration: the operator's keys from the relayer, the wallet's own key as abort.
 *
 * - `pauseAuthority` and the whole `resumeQuorum` are the **operator's** keys, published by the
 *   relayer's `/config`. Three server keys are plural in key material only; one operator holding
 *   the whole quorum is weaker than the shape suggests, and `validateVetoConfig` cannot see it
 *   because the keys genuinely differ.
 * - `abortAuthority` is the wallet's **own active key**, which the SDK calls the natural default:
 *   the common case for abort is someone opening a recovery while the owner still has access. Being
 *   seed-derived is fine. The one hard rule is that it must not be seal-gated, and the context below
 *   declares that, so `protect` can check it rather than being handed `{}`.
 *
 * A separate offline abort key would be *stronger*, because it survives losing the owner key. That
 * is a tradeoff for a holder to make, not a constraint to impose.
 */
import type { Authority, RelayConfig, VetoConfig } from "@nihilium/recovery-core";
import type { VetoContext } from "@nihilium/recovery-sdk";

export function demoVetoConfig(inputs: {
    namespace: string;
    /** What the relayer publishes for this chain. */
    published: Pick<RelayConfig, "pauseAuthority" | "resumeMembers" | "resumeThreshold" | "timelockSeconds" | "pauseCeilingSeconds">;
    /** The wallet's own key. */
    abortAuthority: string;
    /** The owner's choice, made at seal time; the operator's default for older vaults. */
    timelockSeconds?: number | undefined;
}): VetoConfig {
    const authority = (id: string): Authority => ({ namespace: inputs.namespace, id });
    return {
        pauseAuthority: authority(inputs.published.pauseAuthority),
        abortAuthority: authority(inputs.abortAuthority),
        resumeQuorum: {
            members: inputs.published.resumeMembers.map(authority),
            threshold: inputs.published.resumeThreshold,
        },
        timelockSeconds: inputs.timelockSeconds ?? inputs.published.timelockSeconds,
        pauseCeilingSeconds: inputs.published.pauseCeilingSeconds,
    };
}

/**
 * Declared rather than withheld. `sealGated: []` says none of these authorities is gated behind the
 * seal — true here, and the one property §7 still requires of an abort key. `conditionSurface: []`
 * says nothing reachable by forging the identity gate can also resume: the guardians are email
 * addresses and the resume members are server keys, disjoint by construction.
 */
export const VETO_CONTEXT: VetoContext = { sealGated: [], conditionSurface: [] };
