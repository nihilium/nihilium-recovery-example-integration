/**
 * What every live Nihilium adapter in this app shares: where the protocol is, and who pays for it.
 *
 * Both live adapters — zkEmail alone, and zkEmail fused with a passport — seal through the same
 * processor cohort and are billed through the same payment provider, so the key check and the global
 * endpoint are set up once, here, rather than in two copies that could disagree about which API a
 * ceremony talks to.
 *
 * **To replace:** `apiKey`. This demo ships it to the browser, which the SDK names loudly for what
 * it is: `NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE`. It is a spend limit on sealing rather
 * than access to anyone's funds, and a real wallet still keeps its payment provider behind its own
 * backend, so the key never leaves a server it controls.
 * **Assumes:** one API endpoint per page. `setApiEndpoint` is global to the client SDK, so two
 * adapters configured against different endpoints would silently share whichever was set last.
 */
import {
    NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE,
    setApiEndpoint,
    type PaymentProvider,
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

/** Refuses without a key, points the client SDK at the API, and returns the payment provider. */
export function livePayment(config: LiveCeremonyConfig): PaymentProvider {
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

    return new NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE(config.apiUrl, config.apiKey);
}
