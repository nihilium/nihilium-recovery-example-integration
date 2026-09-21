/**
 * The fixed inputs every settlement encoding test uses.
 *
 * Deliberately unmistakable addresses — 0x1111…, 0x2222… — so a mis-ordered field shows up as the
 * wrong repeated digit in a diff rather than as two plausible-looking hex strings.
 */
export const MODULE = "0x55c469aBe9D19db9f88ef023af759FF540B3bCD8" as const;
export const RECOVERY_OWNER = "0x1111111111111111111111111111111111111111" as const;
export const PAUSE = "0x2222222222222222222222222222222222222222" as const;
export const ABORT = "0x3333333333333333333333333333333333333333" as const;
export const RESUME = [
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
    "0x6666666666666666666666666666666666666666",
] as const;

export const VETO = {
    pauseAuthority: PAUSE,
    abortAuthority: ABORT,
    resumeMembers: RESUME,
    resumeThreshold: 2,
    timelockSeconds: 120n,
    pauseCeilingSeconds: 3600n,
} as const;
