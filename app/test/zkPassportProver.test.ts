/**
 * The ZKPassport request, as the prover builds it.
 *
 * The shape of the query is the whole contract with the sealed commitments, and it fails silently:
 * a request built with `eq("birthdate")` produces a real proof from a real passport that still
 * mismatches, because `eq` also puts the date-of-birth bytes into the name disclosure. That cost a
 * live recovery once, so the call sequence is pinned here against a stand-in SDK.
 */
import { describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
const constructed: unknown[][] = [];

vi.mock("@zkpassport/sdk", () => {
    class ZKPassport {
        constructor(...args: unknown[]) {
            constructed.push(args);
        }
        async request() {
            const builder: Record<string, unknown> = {};
            for (const method of ["eq", "range", "disclose", "bind", "facematch"]) {
                builder[method] = (...args: unknown[]) => {
                    calls.push([method, ...args]);
                    return builder;
                };
            }
            builder["done"] = () => ({
                url: "https://zkpassport.id/r?test",
                requestId: "request-1",
                onRequestReceived: () => {},
                onGeneratingProof: () => {},
                onReject: () => {},
                onError: () => {},
                onProofGenerated: () => {},
            });
            return builder;
        }
        cancelRequest() {}
    }
    return { ZKPassport };
});

const { createZkPassportProver } = await import(
    "../src/integration/conditions/passport/zkPassportProver.js"
);

describe("the ZKPassport request", () => {
    it("bounds the birthdate with a range, discloses only the name, and binds this recovery", async () => {
        const prover = createZkPassportProver({ domain: "localhost", name: "test", purpose: "test" });
        const controller = new AbortController();
        const link = new Promise<string>((resolve) => {
            void prover
                .prove(
                    { birthdate: "1990-05-04", firstname: "Olaf", lastname: "van Wijk", customData: "0xabc" },
                    { onLink: resolve, onStatus: () => {} },
                    controller.signal,
                )
                .catch(() => {});
        });
        expect(await link).toBe("https://zkpassport.id/r?test");
        controller.abort();

        const day = new Date(Date.UTC(1990, 4, 4));
        expect(calls).toEqual([
            ["range", "birthdate", day, day],
            ["disclose", "firstname"],
            ["disclose", "lastname"],
            ["bind", "custom_data", "0xabc"],
            ["facematch", "regular"],
        ]);
        // `eq` anywhere would put its field into the disclose mask and break the name match.
        expect(calls.some(([method]) => method === "eq")).toBe(false);
        // No upload of the disclosed name to ZKPassport's dashboard.
        expect(constructed).toEqual([["localhost", { disableProofStorage: true }]]);
    });
});
