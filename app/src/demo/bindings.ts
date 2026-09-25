/**
 * The one binding point.
 *
 * Chain registry, method registry and stores are built here together, because they have to move as
 * a unit: stores pointed at one database with a ledger pointed at another is a bug that looks like
 * configuration.
 *
 * **This app runs the live ceremony.** Sealing is paid, recovery emails real people and waits for
 * them. There is no free mode to fall back to, and that is deliberate: a demo that silently ran
 * something free while claiming to be real would be teaching the wrong thing about what recovery
 * costs.
 *
 * Building the method registry can fail — no API key is the common one — and a throw here would
 * take the whole page with it, since this runs inside `App.tsx`'s `useMemo`. So the failure is
 * carried as a value instead: the wallet still renders, and the recovery panel says exactly what is
 * missing.
 */
import { createChainRegistry } from "../integration/chains/registry.js";
import type { ChainRegistry } from "../integration/chains/types.js";
import { createMethodRegistry } from "../integration/conditions/registry.js";
import type { MethodRegistry } from "../integration/conditions/types.js";
import { VaultRecordStore } from "../integration/recovery/vaultRecords.js";
import { HandoverStore } from "../integration/recovery/handovers.js";
import type { VaultDeps } from "../integration/recovery/vault.js";
import { IdbSealedDataStore } from "../integration/storage/dataStore.js";
import { IdbSealStore } from "../integration/storage/sealStore.js";
import { readEnv, type DemoEnv } from "./env.js";
import { createRecordHost, type RecordHost } from "../integration/recovery/recordHost.js";

export interface AppBindings {
    env: DemoEnv;
    chains: ChainRegistry;
    /** `null` when the live ceremony could not be configured; `methodError` says why. */
    methods: MethodRegistry | null;
    methodError: string | null;
    vaults: VaultRecordStore;
    /** Recoveries submitted on-chain and waiting out a timelock. Holds intents, never keys. */
    handovers: HandoverStore;
    stores: VaultDeps;
    /** This app's record host, written into every seal file it produces. */
    recordHostUrl: string;
    /**
     * A client for a host — the vault's own, or this app's. Can append only when the demo's append
     * secret is configured; reading needs no credential, so a recovery works without it.
     */
    recordHost(url?: string): RecordHost;
}

export function createAppBindings(): AppBindings {
    const env = readEnv();

    const sealStore = new IdbSealStore();
    const dataStore = new IdbSealedDataStore();
    const vaults = new VaultRecordStore();
    const handovers = new HandoverStore();
    // The server's record role, mounted at `/api`: `GET|POST /api/records/:id`.
    const recordHostUrl = `${env.serverUrl.replace(/\/+$/, "")}/api`;

    let methods: MethodRegistry | null = null;
    let methodError: string | null = null;
    try {
        methods = createMethodRegistry({
            live: {
                emailServiceUrl: env.nihilium.emailServiceUrl,
                apiUrl: env.nihilium.apiUrl,
                apiKey: env.nihilium.apiKey ?? "",
                network: env.chainId,
                // Nihilium's **processor** cohort, not the guardian quorum. The public registry
                // lists one processor, so 1-of-1 is the only honest setting against it today.
                processorThreshold: env.nihilium.processorThreshold,
                processorCount: env.nihilium.processorCount,
            },
            // What the ZKPassport app shows the holder. The domain has to be this page's own: the
            // app displays it as the requester, and a mismatch is what phishing looks like.
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
        chains: createChainRegistry({
            evmRpcUrl: env.sepoliaRpcUrl,
            evmBundlerUrl: env.bundlerUrl,
            solanaRpcUrl: env.solanaRpcUrl,
            serverUrl: env.serverUrl,
            moduleAttester: env.moduleAttester,
        }),
        methods,
        methodError,
        vaults,
        handovers,
        stores: { sealStore, dataStore, vaults },
        recordHostUrl,
        recordHost: (url = recordHostUrl) =>
            createRecordHost({
                url,
                ...(env.recordAppendSecret === undefined
                    ? {}
                    : { appendCredential: env.recordAppendSecret }),
            }),
    };
}
