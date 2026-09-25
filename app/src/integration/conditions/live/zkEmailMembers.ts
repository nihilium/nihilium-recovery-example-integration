/**
 * The live identity ceremony: a real zkEmail member, billed per seal.
 *
 * This is the file the simulated adapter stands in for, and the only difference between running
 * this demo for free and running it for real. Everything it constructs is the SDK's:
 * `ZKEmailConditionAdapter` runs the k-of-n ceremony across Nihilium's processor cohort, and the
 * payment provider buys each processor's participation.
 *
 * **What this costs.** Sealing is **paid**, once per guardian, and takes tens of seconds of Groth16
 * proving per share. Recovery sends a real email to each named guardian and blocks until a human
 * replies — minutes, not seconds, and there is no fast path.
 *
 * **To replace:** the payment provider, in `ceremony.ts`.
 * **Assumes:** a network whose Nihilium deployment can verify email proofs — Sepolia today. The
 * adapter's constructor refuses anything else rather than failing at recovery time.
 */
import { ZKEmailConditionAdapter } from "@nihilium/recovery-condition-zkemail";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import { livePayment, type LiveCeremonyConfig } from "./ceremony.js";

export type { LiveCeremonyConfig } from "./ceremony.js";
export { LiveCeremonyUnavailableError } from "./ceremony.js";

/**
 * One adapter serves every guardian: it is stateless, and each member carries its own address in
 * the params the quorum forwards. That is also why the returned value can be shared across slots.
 */
export function createZkEmailAdapter(config: LiveCeremonyConfig): ConditionAdapter {
    const payment = livePayment(config);
    return new ZKEmailConditionAdapter({
        emailServiceUrl: config.emailServiceUrl,
        network: config.network,
        threshold: config.processorThreshold,
        processorCount: config.processorCount,
        payment,
    });
}
