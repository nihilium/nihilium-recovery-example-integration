/**
 * One ZKPassport request, start to proof: the half of a passport recovery the SDK leaves to the app.
 *
 * `@nihilium/recovery-condition-zkemail-zkpassport` computes *what* must be proven — the identity
 * sealed against and the `custom_data` value this recovery binds to — and verifies the proof it is
 * handed. It deliberately does not scan anything, because the ZKPassport SDK belongs where the QR
 * code is. This file is that scan, as a plain promise: no React, so a Vue or Node caller can use it.
 *
 * **To replace:** `name`, `purpose` and `logo`, which the ZKPassport app shows the holder, and
 * `domain`, which it shows as the requester. The demo passes `window.location.hostname`.
 * **Assumes:** `@zkpassport/sdk` 0.16 — the version nihilium-core's passport commitments are built
 * against — and a verifier network that has learned this circuit's verification key. The query below
 * must stay in the order the SDK's passport module reads it; see `prove`.
 */
import type { ZKPassport } from "@zkpassport/sdk";
import {
    normalizeBirthdate,
    type PassportIdentity,
    type PassportVerifierParameters,
} from "@nihilium/recovery-condition-zkpassport";

/**
 * Scope and dev mode, once.
 *
 * They must agree between `request()` and `getSolidityVerifierParameters()`, or the service config
 * baked into the returned parameters describes a different request than the one that was proven.
 * Two call sites each spelling them out is how that drifts.
 */
export const ZKPASSPORT_REQUEST = { scope: "nihilium-vault", devMode: false } as const;

/** What the adapter's `onPassportRequest` hands over: the sealed identity plus the bound value. */
export type PassportRequest = PassportIdentity & { customData: string };

/** Where one request has got to. `waiting` is the one with a link a human has to open. */
export type PassportScanStatus = "starting" | "waiting" | "scanned" | "generating" | "verifying";

export interface PassportProveEvents {
    /** The request's URL: a QR code on a desktop, a deep link on the phone itself. */
    onLink(url: string): void;
    onStatus(status: PassportScanStatus): void;
}

export interface PassportProver {
    /**
     * Rejects if the holder declines, the app reports an error, or `signal` aborts — in which case
     * the request is cancelled at the bridge rather than left open.
     */
    prove(
        request: PassportRequest,
        events: PassportProveEvents,
        signal?: AbortSignal,
    ): Promise<PassportVerifierParameters>;
}

export interface ZkPassportProverOptions {
    /** Shown to the holder as the requester. Must be the page's own host. */
    domain: string;
    name: string;
    purpose: string;
    logo?: string;
}

export function createZkPassportProver(options: ZkPassportProverOptions): PassportProver {
    // One instance for the page: it owns the bridge connections, and `cancelRequest` has to reach
    // the same one that opened the request.
    let sdk: ZKPassport | null = null;

    return {
        async prove(request, events, signal) {
            signal?.throwIfAborted();
            events.onStatus("starting");
            // Loaded on first use, not at import: it is large, it is needed only mid-recovery, and a
            // page that never recovers should not pay for it.
            if (sdk === null) {
                const { ZKPassport } = await import("@zkpassport/sdk");
                // Off: given a domain, the SDK otherwise uploads every verified proof — disclosed
                // name included — to ZKPassport's dashboard. A recovery has no reason to publish
                // who just recovered, and for a domain not registered there it only earns a 403.
                sdk = new ZKPassport(options.domain, { disableProofStorage: true });
            }
            const zkPassport = sdk;

            const query = await zkPassport.request({
                name: options.name,
                purpose: options.purpose,
                ...(options.logo === undefined ? {} : { logo: options.logo }),
                scope: ZKPASSPORT_REQUEST.scope,
                mode: "compressed-evm",
                devMode: ZKPASSPORT_REQUEST.devMode,
            });

            // Call order is load-bearing: parameter-commitment slots follow request order, and the
            // SDK's passport module reads the birthdate claim and the name from fixed slots. Both
            // names are disclosed because the sealed commitment covers the whole MRZ name field.
            // `custom_data` is what ties this scan to this recovery's email and to nothing else.
            //
            // `range(d, d)`, never `eq(d)`. Both give the date circuit the same min = max, so the
            // birthdate commitment is identical — but `@zkpassport/utils` also adds every `eq` field
            // to the *disclose* mask, which folds the MRZ date-of-birth bytes into the name
            // commitment. The sealed name candidates cover the name alone, so an `eq` proof can
            // never match them: the passport is right and the check still says it is not.
            const birthdate = normalizeBirthdate(request.birthdate);
            const built = query
                .range("birthdate", birthdate, birthdate)
                .disclose("firstname")
                .disclose("lastname")
                .bind("custom_data", request.customData)
                .facematch("regular")
                .done();

            return await new Promise<PassportVerifierParameters>((resolve, reject) => {
                let settled = false;
                const finish = (outcome: () => void) => {
                    if (settled) return;
                    settled = true;
                    signal?.removeEventListener("abort", onAbort);
                    outcome();
                };
                const onAbort = () => {
                    zkPassport.cancelRequest(built.requestId);
                    finish(() => reject(signal?.reason ?? new Error("Passport request cancelled.")));
                };
                signal?.addEventListener("abort", onAbort, { once: true });

                built.onRequestReceived(() => events.onStatus("scanned"));
                built.onGeneratingProof(() => events.onStatus("generating"));
                built.onReject(() =>
                    finish(() => reject(new Error("The request was declined in the ZKPassport app."))),
                );
                built.onError((error) => finish(() => reject(new Error(error))));
                // Compressed-EVM mode yields one proof; anything after the first is ignored rather
                // than submitted twice.
                built.onProofGenerated((proof) =>
                    finish(() => {
                        events.onStatus("verifying");
                        try {
                            // A superset of what the adapter reads: it needs the verification
                            // data and nothing of the service config.
                            const params: PassportVerifierParameters =
                                zkPassport.getSolidityVerifierParameters({
                                    proof,
                                    scope: ZKPASSPORT_REQUEST.scope,
                                    devMode: ZKPASSPORT_REQUEST.devMode,
                                });
                            resolve(params);
                        } catch (error) {
                            reject(error instanceof Error ? error : new Error(String(error)));
                        }
                    }),
                );

                events.onLink(built.url);
                events.onStatus("waiting");
            });
        },
    };
}
