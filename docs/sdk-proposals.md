# Changes this example wants from the SDK

CLAUDE.md's rule is that this repo never edits `../recovery-sdk`: when the SDK needs a change to make
an example clean, the example is written around it and the change is proposed here, **with what it
costs us if declined**. This file is that list. Each entry says what exists now, what the workaround
in this repo is, and what the workaround teaches a reader that it should not.

---

## 1. `recoverAll({ proof, chains })` — one ceremony, every chain

**Today.** `RecoverySDK.recover()` takes one `ChainContext` and returns one authority. The paid,
human-in-the-loop half of a recovery is `ConditionAdapter.openRecords`, which already decrypts
*every* record in the vault in one pass — the zkEmail adapter's own header says "the email exchange
and the human wait happen once for the whole batch", and the quorum adapter's says five chains behind
a 3-of-5 cost three ceremonies rather than fifteen.

But `recover()` calls `openRecords` once per call and wipes the plaintexts on the way out. So a
wallet recovering a two-chain vault the obvious way — a loop over `recover()` — **emails every named
guardian twice**, for data that was decrypted and discarded the first time. Nothing in the stack
reports that it happened.

**What this repo does instead.** [`oneCeremony.ts`](../app/src/integration/recovery/oneCeremony.ts)
wraps the `ConditionAdapter` so the first `openRecords` runs the real ceremony and every later one
returns copies of the same plaintexts. `recover()` is then called once per chain, unchanged, and
keeps every guarantee it makes. `recoverAll.ts` drives the loop.

**What that costs.**

- The wrapper holds every chain's root secret in memory for the whole loop, rather than for one
  call. `recover()`'s own `finally` wipes what it is handed; ours cannot, because the next chain
  needs it. That is strictly worse hygiene than the SDK's, and it is the price of one ceremony.
- The copy is load-bearing and non-obvious: `recover()` zeroes every plaintext it receives, so
  returning the cached originals empties the cache and the second chain decrypts nothing — surfacing
  as *"these records belong to another vault"*, which points nowhere near the cause.
- It assumes every `openRecords` call within one recovery asks the same question. True for both
  shipped adapters, which key only on `seal` and `records` and ignore `params.chain`. An adapter that
  varied its answer by chain would be served the first chain's plaintexts for the rest.
- A reader copying this file copies a wrapper around the SDK, which is not what an example should be
  teaching. The batching belongs in the orchestrator that already knows the vault is one record set.

**Proposed shape.**

```ts
recoverAll(params: {
    proof: ConditionProof;
    chains: readonly ChainContext[];
    options?: RecoverOptions;
    seal?: SealBlob;
    entries?: readonly SealedDataEntry[];
    onProgress?: (message: string) => void;
}): Promise<{
    /** One per requested chain, in order. A chain that failed carries the reason. */
    results: readonly ({ chain: ChainContext } & (
        | { ok: true; authority: RecoveredAuthority }
        | { ok: false; reason: string }
    ))[];
    spent: SpentSeal;
}>;
```

Per-chain failure as a value rather than a throw matters as much as the batching: a vault may hold a
chain the caller has no key adapter for, and losing the other chains' keys to it means paying for a
second ceremony to get them back.

**If declined:** we keep `oneCeremony.ts`, and this document is the explanation a reader needs for
why an example wraps its own dependency.

---

## 2. Deployment metadata from `@nihilium/recovery-onchain-evm`

**Today.** The package exports `recoveryModuleAddresses` and `recoveryModuleAddress(chainId)`, and
ships `deployments/*.json` in `files` — but its `exports` map declares only `"."`, so
`deployments/11155111.json` is not reachable by subpath import.

**Why we want it.** `RecoveryRegistered(address indexed account, address indexed recoveryOwner, ...)`
indexes the recovery key, so one `eth_getLogs` answers *"which accounts does this recovered key
protect?"* — the query that makes "take control" possible without a wallet keeping its own list. A
log scan needs a lower bound, and the honest one is the deployment block, which the JSON already
records as `deployedAtBlock`.

**What this repo does instead.** Pins `11668778` as a constant with a comment naming the file it came
from.

**What that costs.** A hand-copied constant that no test can check against its source, in an example
whose whole point is to be copied. A reader on another chain has no way to find theirs except by
reading a file the package does not expose.

**Proposed shape.** Either add a `"./deployments/*"` entry to `exports`, or export
`recoveryModuleDeployment(chainId): { address: Address; deployedAtBlock: bigint; version: string }`.
The `version` is worth having in the same call for a separate reason: the Sepolia deployment answers
`"2.0.0"` while the checked-out Solidity answers `"3.0.0"`, and that string sits inside the EIP-712
domain separator — which is why this repo reads every digest from the chain rather than computing it.

**If declined:** the constant stays, with the comment.

---

## 3. The passport query shape: `range("birthdate", d, d)`, not `eq`

**Today.** The combined adapter's README points at `forgot-my-password-ui`'s `ZKPassportStep.tsx` as
the model request, and that component bounds the date of birth with `query.eq("birthdate", d)`. In
`@zkpassport/utils`, every field with an `eq` constraint is also added to the *disclose* mask. The date
circuit is unaffected: `eq` and `range(d, d)` give it the same bounds, so the birthdate commitment
matches. But the name disclosure then carries the six date-of-birth characters from the
machine-readable zone as well. nihilium-core's `generateFirstnameDiscloseCommitmentCandidates` commits
to the name alone, so a proof from the correct passport can never match. `setPassportProof` then
reports "This passport does not match the name and date of birth this vault was sealed for".

This was found on this repo's first live recovery. For a passport reading `VAN<WIJK<<OLAF…`, a
name-only disclosure reproduces the sealed candidate exactly (`0x0060ac2f…`), while name plus date of
birth gives `0x00f5784a…`.

**What this repo does instead.** `passport/zkPassportProver.ts` uses `range("birthdate", d, d)`, and
`app/test/zkPassportProver.test.ts` pins the whole call sequence, including that `eq` never appears.
Existing seals are unaffected, because nothing on the sealing side changes.

**What it costs if nothing changes upstream.** Every integrator who copies the reference component
gets a recovery that works up to the last step and then fails on a correct passport, with an error
message that points at the user's data rather than at the query. The adapter README's own statement
that "call order is load-bearing" makes the `eq` example look authoritative.

**Proposed change.** Change the reference component and the README to `range`. Better still, have
`setPassportProof` recognise a disclose commitment that also covers the date-of-birth bytes and name
the query as the cause. The information is available: the candidate set is known, so the
date-of-birth-extended variants could be generated and matched against the proof.

**If declined:** the comment and the test here stay, and each integrator relearns this.
