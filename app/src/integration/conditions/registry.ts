/**
 * The method list.
 *
 * This app runs the **live ceremony**: naming guardians buys a real seal per guardian, and
 * recovering sends real email and waits for real people. The simulated adapter still exists next
 * door, but only the test suite uses it — a test that spent money on every run would be a test
 * nobody runs.
 *
 * **To replace:** the whole file. It is the wiring for this demo; a real wallet binds one method
 * from its own configuration and offers no picker.
 * **Assumes:** an API key is configured. Without one there is no method to offer, and this throws
 * `LiveCeremonyUnavailableError` rather than quietly degrading to something free that would teach
 * the wrong thing about what recovery costs.
 */
import type { ConditionAdapter, SealBlob } from "@nihilium/recovery-core";
import type { MethodOffer, Subject } from "./types.js";
import { UNWIRED_OFFERS } from "./catalogue.js";
import { createEmailQuorumMethod } from "./emailQuorum.js";
import {
    createEmailPassportMethod,
    EMAIL_PASSPORT_BLURB,
    EMAIL_PASSPORT_LABEL,
    EMAIL_ZKPASSPORT_METHOD_ID,
} from "./emailPassport.js";
import { createEmailSubjectKind } from "./subjects/email.js";
import { createEmailPassportSubjectKind } from "./subjects/emailPassport.js";
import { createDkimPreflight } from "./preflight/dkim.js";
import { createZkEmailAdapter, type LiveCeremonyConfig } from "./live/zkEmailMembers.js";
import { createZkEmailZkPassportAdapter } from "./live/zkEmailZkPassport.js";
import {
    createZkPassportProver,
    type PassportProver,
    type ZkPassportProverOptions,
} from "./passport/zkPassportProver.js";
import type { MethodRegistry, RecoveryMethod } from "./types.js";

export type { LiveCeremonyConfig } from "./live/zkEmailMembers.js";
export { LiveCeremonyUnavailableError } from "./live/zkEmailMembers.js";

export interface MethodRegistryOptions {
    live: LiveCeremonyConfig;
    /** How the passport method's ZKPassport requests present themselves to the holder. */
    passport: ZkPassportProverOptions;
    /** Injected by tests, so the method layer can be exercised without a key or a network. */
    adapterFactory?: (config: LiveCeremonyConfig) => ConditionAdapter;
    /** The same, for the fused email-and-passport adapter. */
    fusedAdapterFactory?: (config: LiveCeremonyConfig) => ConditionAdapter;
    /** The same, for the passport scan. */
    passportProver?: PassportProver;
}

export function createMethodRegistry(options: MethodRegistryOptions): MethodRegistry {
    const methods: RecoveryMethod[] = [createEmailQuorum(options)];

    // Built on its own, because its adapter refuses any network missing one of the five verifiers
    // the fused graph needs. That is a fact about this method, not about the page: email still
    // works, and the picker shows the refusal as the reason this one does not.
    const refused: MethodOffer[] = [];
    try {
        methods.push(createEmailPassport(options));
    } catch (error) {
        refused.push({
            id: EMAIL_ZKPASSPORT_METHOD_ID,
            label: EMAIL_PASSPORT_LABEL,
            icon: "ShieldCheck",
            blurb: EMAIL_PASSPORT_BLURB,
            available: false,
            unavailable: error instanceof Error ? error.message : String(error),
        });
    }

    const byId = new Map(methods.map((method) => [method.id, method]));

    // Derived from what was actually constructed, so an offer cannot claim to be available while
    // `get()` returns undefined. The unwired entries are appended, never interleaved: the working
    // ones should be the first thing the picker lands on.
    const offers: MethodOffer[] = [
        ...methods.map((method) => ({
            id: method.id,
            label: method.label,
            icon: method.icon,
            blurb: method.blurb,
            available: true,
        })),
        ...refused,
        ...UNWIRED_OFFERS,
    ];

    return {
        all: () => [...methods],
        get: (id) => byId.get(id),
        require(id) {
            const method = byId.get(id);
            if (method === undefined) {
                throw new Error(`No recovery method "${id}". Known: ${[...byId.keys()].join(", ")}`);
            }
            return method;
        },
        offers: () => offers,
    };
}

function createEmailQuorum(options: MethodRegistryOptions): RecoveryMethod {
    const factory = options.adapterFactory ?? createZkEmailAdapter;
    const adapter = factory(options.live);

    return createEmailQuorumMethod({
        mode: "live",
        paid: true,
        kind: createEmailSubjectKind({
            // Stateless, so one instance serves every slot: each member's address travels in the
            // params the quorum forwards, not in the adapter.
            adapterFor: (_subject: Subject, _index: number) => adapter,
            // The registry check runs against the same service the ceremony will: a domain it
            // cannot prove is a guardian whose share could never be opened, and finding that out
            // here costs nothing while finding it out at recovery costs everything.
            preflight: createDkimPreflight({ serviceUrl: options.live.emailServiceUrl }),
        }),
    });
}

function createEmailPassport(options: MethodRegistryOptions): RecoveryMethod {
    const factory = options.fusedAdapterFactory ?? createZkEmailZkPassportAdapter;
    const adapter = factory(options.live);

    return createEmailPassportMethod({
        mode: "live",
        paid: true,
        kind: createEmailPassportSubjectKind({
            // Stateless like the zkEmail one: the identity travels in the params, and at recovery
            // the adapter reads it back off the seal.
            adapterFor: (_subject: Subject, _index: number) => adapter,
            // The same DKIM check: the email half of this gate is exactly as unprovable against an
            // unsupported domain as a guardian's would be.
            preflight: createDkimPreflight({ serviceUrl: options.live.emailServiceUrl }),
            prover: options.passportProver ?? createZkPassportProver(options.passport),
        }),
        ...(adapter.publicComponentOf === undefined
            ? {}
            : { readSeal: (seal: SealBlob) => adapter.publicComponentOf!(seal) }),
    });
}
