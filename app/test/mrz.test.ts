/**
 * The MRZ preview against the SDK's own commitments.
 *
 * `passport/mrz.ts` mirrors a function nihilium-core does not export, and it exists to tell a user
 * "your passport must read exactly this". A preview that drifted from what is actually sealed would
 * be worse than none, so every line it shows is hashed the way the ZKPassport disclosure is, and the
 * SDK's commitment set for the same name must contain it.
 */
import { describe, expect, it } from "vitest";
import { generateSignalCommitments } from "@nihilium/recovery-nihilium";
import { getDiscloseEVMParameterCommitment } from "@zkpassport/utils";
import { MRZ_NAME_OFFSET, mrzNameCandidates } from "../src/integration/conditions/passport/mrz.js";

/** The name disclosure: the MRZ from the start of the name to the end of the first given name. */
async function disclosureCommitment(compared: string): Promise<string> {
    const mask = new Array<number>(90).fill(0);
    const bytes = new Array<number>(90).fill(0);
    for (let i = 0; i < compared.length; i++) {
        mask[MRZ_NAME_OFFSET + i] = 1;
        bytes[MRZ_NAME_OFFSET + i] = compared.charCodeAt(i);
    }
    const commitment = await getDiscloseEVMParameterCommitment(mask, bytes);
    return "0x" + commitment.toString(16).padStart(64, "0");
}

async function sealed(firstname: string, lastname: string): Promise<string[]> {
    const commitments = await generateSignalCommitments({ firstname, lastname });
    return Object.values(commitments.firstname ?? {}).flat();
}

describe("the MRZ name preview", () => {
    it("shows what a passport reading VAN<WIJK<<OLAF must match", async () => {
        const candidates = mrzNameCandidates("Olaf Frederic Michel", "van Wijk");
        expect(candidates.map((c) => c.compared)).toEqual(["VAN<WIJK<<OLAF", "VANWIJK<<OLAF"]);
        expect(candidates[0]!.field).toBe("VAN<WIJK<<OLAF<FREDERIC<MICHEL<<<<<<<<<");
        // The commitment a real passport's proof carried on this repo's first live recovery.
        expect(await disclosureCommitment("VAN<WIJK<<OLAF")).toBe(
            "0x0060ac2ff6f9d9c9317379efbe03234a455c32e57f37b5d46fef0a0bc79fd841",
        );
    });

    it.each([
        ["Olaf", "van Wijk"],
        ["Olaf Frederic Michel", "van Wijk"],
        ["José María", "García-López"],
        ["Ada", "Lovelace"],
    ])("shows only lines the SDK seals, for %s %s", async (firstname, lastname) => {
        const accepted = await sealed(firstname, lastname);
        const candidates = mrzNameCandidates(firstname, lastname);
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) {
            expect(accepted, `${candidate.compared} is shown but not sealed`).toContain(
                await disclosureCommitment(candidate.compared),
            );
        }
    });

    it("drops accents and punctuation the way the SDK does", () => {
        expect(mrzNameCandidates("José", "García-López").map((c) => c.compared)).toEqual([
            "GARCIA<LOPEZ<<JOSE",
            "GARCIALOPEZ<<JOSE",
        ]);
    });

    it("shows nothing until both names are there", () => {
        expect(mrzNameCandidates("Olaf", " ")).toEqual([]);
        expect(mrzNameCandidates("", "van Wijk")).toEqual([]);
    });
});
