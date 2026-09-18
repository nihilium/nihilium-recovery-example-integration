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
import type { ConditionAdapter } from "@nihilium/recovery-core";
import type { MethodOffer, Subject } from "./types.js";
import { UNWIRED_OFFERS } from "./catalogue.js";
import { createEmailQuorumMethod } from "./emailQuorum.js";
import { createEmailSubjectKind } from "./subjects/email.js";
import { createDkimPreflight } from "./preflight/dkim.js";
import { createZkEmailAdapter, type LiveCeremonyConfig } from "./live/zkEmailMembers.js";
import type { MethodRegistry, RecoveryMethod } from "./types.js";

export type { LiveCeremonyConfig } from "./live/zkEmailMembers.js";
export { LiveCeremonyUnavailableError } from "./live/zkEmailMembers.js";

export interface MethodRegistryOptions {
    live: LiveCeremonyConfig;
    /** Injected by tests, so the method layer can be exercised without a key or a network. */
    adapterFactory?: (config: LiveCeremonyConfig) => ConditionAdapter;
}

export function createMethodRegistry(options: MethodRegistryOptions): MethodRegistry {
    const methods: RecoveryMethod[] = [createEmailQuorum(options)];
    const byId = new Map(methods.map((method) => [method.id, method]));

    // Derived from what was actually constructed, so an offer cannot claim to be available while
    // `get()` returns undefined. The unwired entries are appended, never interleaved: the working
    // one should be the first thing the picker lands on.
    const offers: MethodOffer[] = [
        ...methods.map((method) => ({
            id: method.id,
            label: method.label,
            icon: method.icon,
            blurb: method.blurb,
            available: true,
        })),
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
