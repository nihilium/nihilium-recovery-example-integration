/**
 * Handing the seal to the user as a file.
 *
 * Its own module because two places offer the download — the seal row on the card, and the last step
 * of the seal dialog, which is where it matters most: that step exists so nobody leaves the ceremony
 * without the one artifact it produced.
 */
import { sealFileName, type SealFile } from "../integration/recovery/sealFile.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";

export function downloadSeal(vault: VaultRecord, sealFile: SealFile): void {
    const blob = new Blob([JSON.stringify(sealFile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    // The filename carries the vault id, never an identity: a file called `alice@gmail.com.seal`
    // discloses a guardian to anyone who sees the directory listing.
    anchor.download = sealFileName(vault);
    anchor.click();
    // Revoked immediately: the object URL is a handle on bearer material.
    URL.revokeObjectURL(url);
}
