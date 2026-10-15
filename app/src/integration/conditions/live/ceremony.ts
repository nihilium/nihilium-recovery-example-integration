/**
 * What every live Nihilium adapter in this app shares: where the protocol is, and who pays for it.
 *
 * Both live adapters — zkEmail alone, and zkEmail fused with a passport — seal through the same
 * processor cohort and are billed through the same payment provider, so the key check and the global
 * endpoint are set up once, here, rather than in two copies that could disagree about which API a
 * ceremony talks to.
 *
 * **Payment goes through this app's own server.** The Nihilium API key is in `server/.env` and
 * nowhere in this bundle: `BackendPaymentProvider` asks the server for a token per processor share,
 * bound to that one share and accepted once, and the server's `PaymentTokenService` adds the key.
 * **To replace:** `paymentCredential`. The demo proves itself with the record append secret, which
 * is in the bundle; a real wallet sends its user's session, and the server checks that instead.
 * **Assumes:** one API endpoint per page. `setApiEndpoint` is global to the client SDK, so two
 * adapters configured against different endpoints would silently share whichever was set last.
 */
import { BackendPaymentProvider, setApiEndpoint, type PaymentProvider } from "@nihilium/recovery-nihilium";

export interface LiveCeremonyConfig {
    emailServiceUrl: string;
    /** The Nihilium API: registry and processor lookups. Free; only sealing is paid. */
    apiUrl: string;
    /** This app's server, which holds the Nihilium API key and mints seal tokens. */
    paymentServerUrl: string;
    /** Proves this app to that server. Empty means there is nothing to authenticate with. */
    paymentCredential: string;
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
 * Refuses without a credential, points the client SDK at the API, and returns the payment provider.
 *
 * Whether the server holds a key is not knowable here without a request; `/health` reports it, and
 * a seal against a server without one fails with a message naming `NIHILIUM_API_KEY`.
 */
export function livePayment(config: LiveCeremonyConfig): PaymentProvider {
    if (config.paymentCredential.trim() === "") {
        throw new LiveCeremonyUnavailableError(
            "Sealing is a paid Nihilium operation, paid through this app's server, and there is no " +
                "credential to ask it with. Run `npm run setup:env` to generate VITE_RECORD_APPEND_SECRET " +
                "— see docs/configuration.md.",
        );
    }

    // Global, and set before anything reaches the protocol: the client SDK resolves processors and
    // datastreams through this endpoint, and a default pointing elsewhere fails deep inside a
    // ceremony rather than here.
    setApiEndpoint(config.apiUrl);

    return new BackendPaymentProvider(config.paymentServerUrl, { credential: config.paymentCredential });
}
