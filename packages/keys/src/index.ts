/**
 * Derivation, shared by both halves of this demo.
 *
 * It lives in its own workspace for one reason: the **server derives role keys on two curves** and
 * the app derives wallet keys on the same two. A copy in each would be two implementations that
 * must agree about what a path means, pinned by test vectors in only one of them — and the way that
 * fails is silent, because a wrong derivation still produces a perfectly valid key, just for an
 * account nobody named.
 *
 * It holds the *scheme* and nothing about either consumer: no paths, no mnemonics, no chains. The
 * app's own paths stay in `app/src/integration/keys/paths.ts`, and the server's role paths stay in
 * `server/src/roleIdentity.ts`, because which branch a party derives on is that party's business.
 *
 * **To replace:** nothing — SLIP-0010 and BIP-32 are published schemes, pinned here against their
 * own vectors. **Assumes:** callers hand it a 64-byte BIP-39 seed; turning a mnemonic into one is
 * the caller's job, since the two halves validate mnemonics differently.
 */
export { deriveSecp256k1, deriveEd25519, type DerivedKey } from "./derive.js";
export { slip10Ed25519, parseHardenedPath, UnhardenedPathError } from "./slip10.js";
