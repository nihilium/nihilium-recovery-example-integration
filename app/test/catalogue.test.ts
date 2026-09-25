/**
 * The picker's list against the registry's.
 *
 * The catalogue exists so the picker can show methods this demo has not wired — the SDK ships three
 * condition adapters that fit here and two are integrated, and hiding the third would teach that the
 * integrated ones are the whole surface. The risk that buys is an offer that claims to be usable
 * and then cannot be resolved, so the two lists are checked against each other rather than trusted
 * to stay in step.
 */
import { describe, expect, it } from "vitest";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import { createMethodRegistry } from "../src/integration/conditions/registry.js";
import { UNWIRED_OFFERS } from "../src/integration/conditions/catalogue.js";

/** Never called: every assertion below is about the lists, not about sealing anything. */
const adapterFactory = (): ConditionAdapter => ({}) as ConditionAdapter;

const live = {
    emailServiceUrl: "https://example.invalid",
    apiUrl: "https://example.invalid",
    apiKey: "test",
    network: 11155111,
    processorThreshold: 1,
    processorCount: 1,
};

const passport = { domain: "localhost", name: "test", purpose: "test" };

function registry() {
    return createMethodRegistry({ adapterFactory, fusedAdapterFactory: adapterFactory, live, passport });
}

describe("the method catalogue", () => {
    it("offers the three methods, wired first", () => {
        const offers = registry().offers();
        expect(offers.map((offer) => offer.id)).toEqual([
            "email-quorum",
            "email-zkpassport",
            "zkpassport-quorum",
        ]);
        expect(offers.map((offer) => offer.available)).toEqual([true, true, false]);
    });

    it("greys the passport method out, with the adapter's reason, on a network that cannot verify it", () => {
        // The real fused adapter, on mainnet: its constructor refuses a network missing any of the
        // five verifiers. That refusal belongs to this one method — email must still be offered.
        const methods = createMethodRegistry({
            adapterFactory,
            live: { ...live, network: 1 },
            passport,
        });
        const offers = methods.offers();
        expect(offers.map((offer) => offer.id)).toEqual([
            "email-quorum",
            "email-zkpassport",
            "zkpassport-quorum",
        ]);
        expect(offers.map((offer) => offer.available)).toEqual([true, false, false]);
        const refused = offers.find((offer) => offer.id === "email-zkpassport");
        expect(refused?.unavailable, "the reason is the SDK's, not a generic one").toMatch(/verifier|network/i);
        expect(methods.get("email-zkpassport")).toBeUndefined();
    });

    it("resolves every offer it marks available", () => {
        const methods = registry();
        const broken = methods
            .offers()
            .filter((offer) => offer.available && methods.get(offer.id) === undefined)
            .map((offer) => offer.id);
        expect(broken, "an available offer is one the picker can actually seal with").toEqual([]);
    });

    it("resolves none of the offers it marks unavailable", () => {
        const methods = registry();
        const surprising = methods
            .offers()
            .filter((offer) => !offer.available && methods.get(offer.id) !== undefined)
            .map((offer) => offer.id);
        expect(surprising, "a method that works should not be greyed out").toEqual([]);
    });

    it("gives each unwired method a status line", () => {
        for (const offer of UNWIRED_OFFERS) {
            // A disabled control with nothing beside it reads as a bug. The screen states the fact;
            // which package exists and what wiring it would take is in `catalogue.ts`'s comment.
            expect(offer.unavailable, `${offer.id} is greyed out with no status`).toBe(
                "Not available in this demo.",
            );
        }
    });
});
