/**
 * The machine-readable name lines a passport seal will accept, spelled out so a person can check them.
 *
 * A passport condition does not commit to the name as typed. It commits to how that name would appear
 * in the passport's MRZ — `SURNAME<<GIVEN`, capitals, accents dropped, spaces as `<` — and the proof
 * discloses the real MRZ from the start of the name up to the end of the **first** given name. If no
 * candidate is byte-for-byte equal to that stretch, the vault can never be recovered, and nothing
 * anywhere will say so until a recovery fails. Showing the candidates before sealing turns that into
 * something the user can compare against the bottom of their passport's photo page.
 *
 * **To replace:** nothing, while the SDK does not export this. It mirrors nihilium-core's
 * `buildMrzNameFieldCandidates` (`client-sdk/src/zkpassport/signal_commitments.ts`), which is not
 * exported; `app/test/mrz.test.ts` hashes every line shown here and requires the SDK's own commitment
 * set to contain it, so this cannot drift into showing something that is not what gets sealed.
 * **Assumes:** a passport (TD3: a 39-character name field starting at MRZ position 5). An ID card
 * lays its MRZ out differently and cannot open this seal at all.
 */

/** TD3's name field: 39 characters on the first MRZ line, after `P<` and the issuing state. */
export const MRZ_NAME_FIELD_LENGTH = 39;

/** Where the name field starts in the MRZ, after `P<` and the three-letter issuing state. */
export const MRZ_NAME_OFFSET = 5;

export interface MrzNameCandidate {
    /** The part that is compared: from the start of the surname to the end of the first given name. */
    compared: string;
    /** The whole 39-character field this candidate stands for, padded with `<`. */
    field: string;
}

/** nihilium-core's normalizer, verbatim: accents stripped, capitals, punctuation to spaces. */
function normalizeForMrz(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .trim()
        .replace(/ +/g, " ");
}

/**
 * Every name line the seal will accept, in the order the SDK builds them. Empty when either name is
 * blank, or when the name is too long to fit the field — both of which the SDK would also refuse.
 */
export function mrzNameCandidates(firstname: string, lastname: string): MrzNameCandidate[] {
    const first = normalizeForMrz(firstname);
    const last = normalizeForMrz(lastname);
    if (first === "" || last === "") return [];

    const given = first.replaceAll(" ", "<");
    const firstGiven = first.split(" ")[0]!;
    const fields = new Set<string>();
    // A multi-word surname may be encoded with the space as `<` or dropped; the seal accepts either.
    for (const base of new Set([last, last.replaceAll(" ", "")])) {
        for (const surname of new Set([base.replaceAll(" ", "<"), base.replaceAll(" ", "")])) {
            const field = `${surname}<<${given}`;
            if (field.length <= MRZ_NAME_FIELD_LENGTH) {
                fields.add(field.padEnd(MRZ_NAME_FIELD_LENGTH, "<"));
            }
        }
    }

    return [...fields].map((field) => ({
        compared: field.slice(0, field.indexOf("<<") + 2 + firstGiven.length),
        field,
    }));
}
