/**
 * The live fused ceremony: one zkEmail proof **and** one ZKPassport proof, bound to each other, in
 * one seal.
 *
 * `ZKEmailZKPassportConditionAdapter` is the SDK's, unchanged. What it does not do is scan a
 * passport — it takes no `@zkpassport/*` dependency, because the ZKPassport SDK belongs where the
 * QR code is — so the proof arrives through `onPassportRequest`, which `subjects/emailPassport.ts`
 * wires to `passport/zkPassportProver.ts`.
 *
 * **What this costs.** Sealing is **paid**, once: one ceremony whatever the processor threshold.
 * Recovery sends one email and asks for one passport scan, concurrently, and blocks until both have
 * happened.
 *
 * **To replace:** the payment provider, in `ceremony.ts`.
 * **Assumes:** a network with all five verifiers the fused graph needs — Sepolia today. The
 * constructor throws on any other, naming what is missing; `registry.ts` turns that into the
 * picker's reason rather than letting it take the email method down too.
 */
import { ZKEmailZKPassportConditionAdapter } from "@nihilium/recovery-condition-zkemail-zkpassport";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import { livePayment, type LiveCeremonyConfig } from "./ceremony.js";

export function createZkEmailZkPassportAdapter(config: LiveCeremonyConfig): ConditionAdapter {
    const payment = livePayment(config);
    return new ZKEmailZKPassportConditionAdapter({
        emailServiceUrl: config.emailServiceUrl,
        network: config.network,
        threshold: config.processorThreshold,
        processorCount: config.processorCount,
        payment,
    });
}
