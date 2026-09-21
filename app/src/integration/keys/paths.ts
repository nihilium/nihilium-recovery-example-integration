/**
 * Derivation paths, one per chain.
 *
 * These strings are permanent in the same way `ChainContext.namespace` is: change one after a seal
 * exists and the wallet derives a different account, whose `accountId` no longer matches the one
 * the seal was bound to. The recovery still "works" — it just hands back authority over an account
 * nobody is using.
 *
 * Each is the chain's own convention, so an address here matches what a mainstream wallet shows for
 * the same phrase. That is worth more than tidiness: it lets a reader check our arithmetic against
 * MetaMask or Phantom.
 *
 * **To replace:** these strings, once, before anything is sealed — and never afterwards. **Assumes:**
 * one account per chain (three for Zcash); a wallet with many would index them here.
 */

/** BIP-44 coin type 60. What MetaMask shows for account 1. */
export const EVM_PATH = "m/44'/60'/0'/0/0";

/**
 * Account 2 on the same phrase — "the new device", where a recovery hands control.
 *
 * A separate account index rather than the wallet's own, because handing control back to
 * `EVM_PATH` would hand it to the key the recovery exists to replace. In a real recovery this is a
 * key on hardware the user still has; here it is the next account along, which is the closest a
 * single-seed demo can get and is labelled as such.
 */
export const EVM_RECOVERY_TARGET_PATH = "m/44'/60'/1'/0/0";

/**
 * Coin type 501, fully hardened — Phantom's and Solflare's path. ed25519 has no unhardened
 * derivation at all under SLIP-0010, so the trailing `'` is not a style choice.
 */
export const SOLANA_PATH = "m/44'/501'/0'/0'";

/**
 * Coin type 133, transparent (t-address) only. Three of them, because the point of including a UTXO
 * chain is that one wallet is many addresses: two receive and one change, the split every
 * transparent wallet makes.
 */
export const ZCASH_PATHS = [
    { path: "m/44'/133'/0'/0/0", label: "t-address 0" },
    { path: "m/44'/133'/0'/0/1", label: "t-address 1" },
    { path: "m/44'/133'/0'/1/0", label: "t-address 2 (change)" },
] as const;
