/**
 * One ceremony, every chain — by making the ceremony idempotent instead of reimplementing it.
 *
 * **The problem.** `RecoverySDK.recover()` returns the authority for *one* `ChainContext`, and the
 * paid, human-in-the-loop part of a recovery is `ConditionAdapter.openRecords`. The zkEmail
 * adapter's own header says the email exchange and the human wait "happen once for the whole batch",
 * which is why it takes a list of records — but the SDK calls it once per `recover()`. So a vault
 * covering EVM and Solana costs **two full rounds of guardian email**, for information that was
 * already decrypted the first time and then wiped.
 *
 * That is the opposite of what this repo exists to show. A ceremony is the expensive half; putting a
 * second chain into a vault is free, and recovering the second chain should be too.
 *
 * **The fix, and why this shape.** The obvious workaround is to call `openRecords` once here and
 * derive each chain's key with `selectEnvelope` + `derivePrivateKeyBytes`, both of which core
 * exports. It works, and it is wrong for an example: it reaches past the orchestrator, so this file
 * would have to re-implement envelope selection, curve checking, the `rawKey`/capability split and
 * the `SpentSeal` wording — the last of which is a claim the SDK owns and a demo must not paraphrase.
 *
 * So instead the *adapter* is wrapped. The first `openRecords` runs the real ceremony; every later
 * one returns the same plaintexts. `recover()` is then called once per chain, unchanged, and keeps
 * every guarantee it makes — while the guardians are asked exactly once.
 *
 * **What it costs, stated plainly.** `recover()` wipes each plaintext before returning, so holding
 * them across calls holds every chain's root secret in memory for the whole loop rather than for one
 * call. That is strictly worse than the SDK's own hygiene, and it is the price of one ceremony
 * instead of n. `wipe()` is not optional, and the caller must run it in a `finally`.
 *
 * The honest fix is an SDK that batches this itself — `recoverAll({proof, chains})` — which is
 * written up in `docs/sdk-proposals.md`.
 *
 * **To replace:** all of it, the day the SDK batches. Nothing else here depends on the shape.
 * **Assumes:** every `openRecords` call in one recovery asks the same question. True because the
 * vault is one record set behind one gate, and because every adapter this app wires — the quorum,
 * zkEmail, and the fused zkEmail + zkPassport one — ignores `params.chain` and keys only on `seal`
 * and `records`. An adapter that varied its answer by chain would be served
 * the first chain's plaintexts for all of them — so `assertRecoveredKeyMatches` runs per chain, and
 * would catch it.
 */
import type { ConditionAdapter, SealBlob, SealPublicComponent } from "@nihilium/recovery-core";

export interface SharedCeremony {
    /** Hand this to every `RecoverySDK` in the loop. */
    adapter: ConditionAdapter;
    /** How many times the real ceremony ran. Should be 1; the test asserts it. */
    ceremonies(): number;
    /** Zeroize the held plaintexts. Not optional — see the header. */
    wipe(): void;
}

export function shareOneCeremony(inner: ConditionAdapter): SharedCeremony {
    let held: Uint8Array[] | null = null;
    let ceremonies = 0;

    // Delegated member by member rather than spread: these adapters are class instances, and
    // `{...inner}` would copy own fields and drop every prototype method.
    const adapter: ConditionAdapter = {
        conditionType: inner.conditionType,
        resolver: inner.resolver,
        buildCondition: (params) => inner.buildCondition(params),
        buildProof: (params) => inner.buildProof(params),
        sealVault: (params) => inner.sealVault(params),
        sealRecord: (params: { publicComponent: SealPublicComponent; record: Uint8Array }) =>
            inner.sealRecord(params),
        publicComponentOf: (seal: SealBlob) => inner.publicComponentOf(seal),

        async openRecords(params) {
            if (held === null) {
                ceremonies += 1;
                held = await inner.openRecords(params);
            } else {
                params.onProgress?.(
                    "openRecords  reusing the ceremony already run — the guardians are asked once " +
                        "for the whole vault, not once per chain",
                );
            }
            // **Copies, always.** `recover()` wipes every plaintext it is handed in a `finally`, so
            // returning the originals would zero the cache and leave the next chain decrypting
            // nothing — which surfaces as "these records belong to another vault", pointing nowhere
            // near the cause.
            return held.map((bytes) => Uint8Array.from(bytes));
        },

        // Optional on the interface, so it is forwarded only when the inner adapter has one — a
        // stub that always existed would make a watchtower registration look possible where it is not.
        ...(inner.watchTargets
            ? {
                  watchTargets: (component: SealPublicComponent) =>
                      inner.watchTargets!(component),
              }
            : {}),
    };

    return {
        adapter,
        ceremonies: () => ceremonies,
        wipe() {
            if (held === null) return;
            for (const bytes of held) bytes.fill(0);
            held = null;
        },
    };
}
