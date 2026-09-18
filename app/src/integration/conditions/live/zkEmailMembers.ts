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
 * **To replace:** `apiKey`. This demo ships it to the browser, which the SDK names loudly for what
 * it is: `NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE`. It is a spend limit on sealing rather
 * than access to anyone's funds, and a real wallet still keeps its payment provider behind its own
 * backend, so the key never leaves a server it controls.
 * **Assumes:** a network whose Nihilium deployment can verify email proofs — Sepolia today. The
 * adapter's constructor refuses anything else rather than failing at recovery time.
 */
import { ZKEmailConditionAdapter } from "@nihilium/recovery-condition-zkemail";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import {
    NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE,
    setApiEndpoint,
} from "@nihilium/recovery-nihilium";

export interface LiveCeremonyConfig {
    emailServiceUrl: string;
    apiUrl: string;
    apiKey: string;
    /** The chain whose Nihilium deployment verifies the proofs. Sepolia today. */
    network: number;
    /**
     * Nihilium's **processor** cohort: how many of its processors must cooperate to unseal one
     * member's share. Not the guardian quorum, and never to be called a threshold in user-facing
     * copy without saying which one. The public registry lists a single processor, so 1-of-1 is the
     * only honest setting against it today.
     */
    processorThreshold: number;
    processorCount: number;
}

export class LiveCeremonyUnavailableError extends Error {
    override readonly name = "LiveCeremonyUnavailableError";
}

/**
 * One adapter serves every guardian: it is stateless, and each member carries its own address in
 * the params the quorum forwards. That is also why the returned value can be shared across slots.
 */
export function createZkEmailAdapter(config: LiveCeremonyConfig): ConditionAdapter {
    if (config.apiKey.trim() === "") {
        throw new LiveCeremonyUnavailableError(
            "Sealing is a paid Nihilium operation and no API key is set. Put one in " +
                "app/.env.local as VITE_NIHILIUM_API_KEY — see docs/configuration.md.",
        );
    }

    // Global, and set before anything reaches the protocol: the client SDK resolves processors and
    // datastreams through this endpoint, and a default pointing elsewhere fails deep inside a
    // ceremony rather than here.
    setApiEndpoint(config.apiUrl);

    return new ZKEmailConditionAdapter({
        emailServiceUrl: config.emailServiceUrl,
        network: config.network,
        threshold: config.processorThreshold,
        processorCount: config.processorCount,
        payment: new NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE(config.apiUrl, config.apiKey),
    });
}
