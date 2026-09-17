/**
 * The demo wallet's seed phrase. In plain text, in the repository, on purpose.
 *
 * This is the Hardhat/Anvil default mnemonic — one of the most published strings in Ethereum. That
 * is the point of choosing it: nobody can mistake it for a wallet worth funding, and any address it
 * derives has been swept on every public network for years.
 *
 * **This file is what a real wallet must not copy.** A wallet holds a seed behind a device keystore
 * and never lets it reach application code. This demo needs the opposite — a seed it can show,
 * derive every chain from, and lose on demand — because the thing being demonstrated is recovery
 * from loss, and loss you cannot stage is loss you cannot show.
 */
export const DEMO_MNEMONIC =
    "test test test test test test test test test test test junk";

/** Shown wherever the mnemonic is. Rendered, not just commented — see `ui/DemoBanner.tsx`. */
export const DEMO_MNEMONIC_WARNING =
    "Public test mnemonic, printed in the clear. Never fund these addresses with anything you " +
    "would miss.";
