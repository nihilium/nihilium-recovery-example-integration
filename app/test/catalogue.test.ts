/**
 * The picker's list against the registry's.
 *
 * The catalogue exists so the picker can show methods this demo has not wired — the SDK ships three
 * condition adapters that fit here and one is integrated, and hiding the other two would teach that
 * the integrated one is the whole surface. The risk that buys is an offer that claims to be usable
 * and then cannot be resolved, so the two lists are checked against each other rather than trusted
 * to stay in step.
 */
import { describe, expect, it } from "vitest";
import type { ConditionAdapter } from "@nihilium/recovery-core";
import { createMethodRegistry } from "../src/integration/conditions/registry.js";
import { UNWIRED_OFFERS } from "../src/integration/conditions/catalogue.js";

/** Never called: every assertion below is about the lists, not about sealing anything. */
const adapterFactory = (): ConditionAdapter => ({}) as ConditionAdapter;

function registry() {
    return createMethodRegistry({
        adapterFactory,
        live: {
            emailServiceUrl: "https://example.invalid",
            apiUrl: "https://example.invalid",
            apiKey: "test",
            network: 11155111,
            processorThreshold: 1,
            processorCount: 1,
        },
    });
}

describe("the method catalogue", () => {
    it("offers the three methods, wired first", () => {
        const offers = registry().offers();
        expect(offers.map((offer) => offer.id)).toEqual([
            "email-quorum",
            "email-zkpassport-quorum",
            "zkpassport-quorum",
        ]);
        expect(offers.map((offer) => offer.available)).toEqual([true, false, false]);
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
