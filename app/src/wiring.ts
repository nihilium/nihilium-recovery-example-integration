/**
 * The one binding point: the SDK's packages, this demo's chains and methods, and the stores, built
 * together so they move as a unit.
 *
 * This is the file a wallet copies the *shape* of. Everything the SDK needs arrives here as an
 * instance — three settlement adapters, five IndexedDB stores, a relay submitter, a watchtower client,
 * a record host — and nothing below it reads the environment.
 *
 * **This app runs the live ceremony.** Sealing is paid, recovery emails real people and waits for
 * them. Building the method registry can fail — no credential for the server's payment route is the
 * common one — and that failure is carried as a value: the wallet still renders, and the recovery
 * panel says exactly what is missing.
 */
import { HttpRelaySubmitter, WatchtowerClient } from "@nihilium/recovery-core";
import { createRecordHost, type OrchestrationDeps, type RecordHost } from "@nihilium/recovery-sdk";
import { idbStores } from "@nihilium/recovery-storage-indexeddb";
import { createChainRegistry } from "./integration/chains/registry.js";
import type { ChainRegistry } from "./integration/chains/types.js";
import { createMethodRegistry } from "./integration/conditions/registry.js";
import type { MethodRegistry } from "./integration/conditions/types.js";
import { DEMO_DB_NAME } from "./demo/db.js";
import { readEnv, type DemoEnv } from "./demo/env.js";

export interface AppBindings {
    env: DemoEnv;
    chains: ChainRegistry;
    /** `null` when the live ceremony could not be configured; `methodError` says why. */
    methods: MethodRegistry | null;
    methodError: string | null;
    /** Every store the SDK's orchestration reads and writes, plus the chain registry. */
    deps: OrchestrationDeps;
    /** The relayer: pays for `initiate` and `execute`, publishes the operator's veto keys, runs the faucet. */
    relay: HttpRelaySubmitter;
    /** This app's record host, written into every seal file it produces. */
    recordHostUrl: string;
    /** A client for a host — the vault's own, or this app's. Reading needs no credential. */
    recordHost(url?: string): RecordHost;
    watchtowerUrl: string;
    watchtower(): WatchtowerClient;
}

export function createAppBindings(): AppBindings {
    const env = readEnv();
    const server = env.serverUrl.replace(/\/+$/, "");

    // One submitter for every chain: the server mounts one `RelayerService` for all three, keyed by
    // CAIP-2 namespace. The credential is only needed by the faucet; relaying itself is open.
    const relay = new HttpRelaySubmitter({
        baseUrl: `${server}/api/relay`,
        ...(env.recordAppendSecret === undefined ? {} : { credential: env.recordAppendSecret }),
    });

    const chains = createChainRegistry({
        evmRpcUrl: env.sepoliaRpcUrl,
        evmBundlerUrl: env.bundlerUrl,
        moduleAttester: env.moduleAttester,
        arbitrumSepoliaRpcUrl: env.arbitrumSepoliaRpcUrl,
        solanaRpcUrl: env.solanaRpcUrl,
        relay,
    });

    const recordHostUrl = `${server}/api`;
    const watchtowerUrl = `${server}/api/watchtower`;

    let methods: MethodRegistry | null = null;
    let methodError: string | null = null;
    try {
        methods = createMethodRegistry({
            live: {
                emailServiceUrl: env.nihilium.emailServiceUrl,
                apiUrl: env.nihilium.apiUrl,
                // Sealing is paid through this app's server, which holds the API key.
                paymentServerUrl: server,
                paymentCredential: env.recordAppendSecret ?? "",
                network: env.chainId,
                // Nihilium's **processor** cohort, not the guardian quorum.
                processorThreshold: env.nihilium.processorThreshold,
                processorCount: env.nihilium.processorCount,
            },
            // What the ZKPassport app shows the holder. The domain has to be this page's own.
            passport: {
                domain: window.location.hostname,
                name: "Nihilium recovery demo",
                purpose: "Prove the identity this vault was sealed for",
            },
        });
    } catch (error) {
        methodError = error instanceof Error ? error.message : String(error);
    }

    return {
        env,
        chains,
        methods,
        methodError,
        deps: { ...idbStores({ dbName: DEMO_DB_NAME }), chains },
        relay,
        recordHostUrl,
        recordHost: (url = recordHostUrl) =>
            createRecordHost({
                url,
                ...(env.recordAppendSecret === undefined ? {} : { appendCredential: env.recordAppendSecret }),
            }),
        watchtowerUrl,
        watchtower: () => new WatchtowerClient({ baseUrl: watchtowerUrl }),
    };
}
