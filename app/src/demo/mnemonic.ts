/**
 * What the demo says about its own seed.
 *
 * There used to be a constant here: the published Hardhat phrase, chosen precisely because nobody
 * could mistake it for a wallet worth funding. It is gone, and the reason is worth keeping.
 *
 * **A published key is a key other people use.** The Solana account that phrase derives had been
 * turned into a durable nonce account by somebody else — 51 devnet SOL, an authority we do not
 * hold, and 80 bytes of data that make the System Program refuse to transfer from it. `create_vault`
 * failed with `Transfer: 'from' must not carry data`, which is not a bug in this demo so much as a
 * demonstration of what "published" means. A shared address accumulates other people's state.
 *
 * So the wallet mints its own seed on first run and keeps it (`demo/seeds.ts`). Still plaintext,
 * still printed, still not to be funded with anything real — but nobody else's.
 *
 * **This file is what a real wallet must not copy.** A wallet holds a seed behind a device keystore
 * and never lets it reach application code. This demo needs the opposite — a seed it can show,
 * derive every chain from, and lose on demand — because the thing being demonstrated is recovery
 * from loss, and loss you cannot stage is loss you cannot show.
 */

/** Shown wherever the seed is. Rendered, not just commented — see `ui/DemoBanner.tsx`. */
export const SEED_WARNING =
    "The seed is generated in this browser and printed in the clear. Never fund these addresses " +
    "with anything you would miss.";
