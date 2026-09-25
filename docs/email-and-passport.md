# Email and passport: one person, two factors, one ceremony

The second recovery method in this app. The owner seals the vault against **their own inbox and
their own passport**, and recovers by replying to one email and scanning one passport. Both are
required, and the two proofs are bound to each other.

This is `@nihilium/recovery-condition-zkemail-zkpassport` used unchanged. This repo adds the passport
scan, which the SDK deliberately leaves to the app, and the UI around it.

## The files

| File | What it does |
|---|---|
| [`conditions/emailPassport.ts`](../app/src/integration/conditions/emailPassport.ts) | The method. Calls the fused adapter directly: no quorum. |
| [`conditions/subjects/emailPassport.ts`](../app/src/integration/conditions/subjects/emailPassport.ts) | The four fields, their validation, and the scan loop that answers `onPassportRequest`. |
| [`conditions/passport/zkPassportProver.ts`](../app/src/integration/conditions/passport/zkPassportProver.ts) | One ZKPassport request, start to proof, as a plain promise. No React. |
| [`conditions/live/zkEmailZkPassport.ts`](../app/src/integration/conditions/live/zkEmailZkPassport.ts) | Constructs the live adapter. |
| [`ui/PassportScan.tsx`](../app/src/ui/PassportScan.tsx) | Renders the prompt: a QR code, a deep link, status, and a retry. |

Everything under `integration/` copies into another app as-is. `PassportScan.tsx` is the only piece
that assumes React.

## Why one fused adapter rather than a 2-of-2 quorum

A `QuorumConditionAdapter` over the email adapter and the passport adapter also requires both factors.
It costs two ceremonies, two payments and two record ciphertexts. Its two proofs are also made against
different roots and are never linked to each other.

In the fused adapter, one preimage yields one `tied_hash`. That hash is both the recovery email's
subject and the value the passport proof binds `custom_data` to, so neither proof can be replayed into
another recovery. Wrapping this in a 1-of-1 quorum would add a Shamir layer over a single share and
nothing else, so the method calls the adapter directly.

## Sealing

The owner enters an address, given names, surname and an exact date of birth. `parse` refuses input
the passport half could never open:

- **Either name missing.** The commitment then silently leaves the name out, and no scan would ever
  match it.
- **1900-01-01, 1970-01-01, or any date before 1900.** ZKPassport reads these as "no bound", so a seal
  on one of them would open for any passport. The check is the SDK's own `normalizeBirthdate`, not a
  copy of it.

There is one check only the user can make: whether the typed name is the name in the passport's
machine-readable zone. The seal commits to MRZ spellings of it (`VAN<WIJK<<OLAF`), and a recovery
compares them with the passport byte for byte, up to the end of the first given name.
[`passport/mrz.ts`](../app/src/integration/conditions/passport/mrz.ts) lists those lines. The seal
form shows them with a warning, and "Review" stays disabled until the user confirms their passport
matches one of them. The function mirrors one nihilium-core does not export, so
`app/test/mrz.test.ts` hashes every displayed line and requires the SDK's own commitment set to
contain it.

The address also gets the same live DKIM preflight as the email method, since the email half is
exactly as unprovable against an unsupported domain.

Sealing is paid, and costs **one seal** whatever the processor threshold. `addChain()` stays free,
because `appendAdapter` returns the same adapter and `sealRecord` is local encryption to the vault's
public key.

### What the seal file says about you

**The adapter records the identity on the seal:** the address, both names and the date of birth. It
does this so that recovery needs the seal and nothing re-typed. The confirm step says so before the
paid button.

A seal is a bearer file that ends up in backups, and a date of birth cannot be rotated. An app that
wants an anonymous seal should use `@nihilium/recovery-condition-zkpassport` alone, which records
nothing by default.

The seal's *public component* carries none of this. It is the file that goes to record hosts and
watchtowers, and the adapter builds it from a whitelist.

This app also keeps the typed values in its own gate record in IndexedDB. The seal already holds them,
so that adds no new disclosure, but a wallet copying this should know it is there.

## Recovering

`buildProof` gets the address and an `onPassportRequest` callback. When the ceremony starts, the
adapter sends the recovery email and calls `onPassportRequest` in the same turn, with the sealed
identity and the `customData` this recovery binds to. The two waits run concurrently.

`runScan` in the subject kind answers that call:

1. `PassportProver.prove` builds the request, and its link becomes a prompt.
   `useRecoveryFlow` stores it and `RecoverDialog` renders it as a QR code, which is hidden on narrow
   screens, plus a deep link.
2. The proof goes to the adapter's `submit`, which checks it against the sealed identity.
3. A mismatch rejects `submit` but does **not** end the recovery. The prompt stays up with the reason
   and a *New request* button, and a retry cancels the request in flight at the bridge.
4. Once a proof is accepted, the prompt clears and the member row moves on.

### The request, and why its order matters

```ts
const birthdate = normalizeBirthdate(request.birthdate);
query.range("birthdate", birthdate, birthdate)
     .disclose("firstname")
     .disclose("lastname")
     .bind("custom_data", request.customData)
     .facematch("regular")
     .done();
```

Parameter-commitment slots follow request order, and the SDK's passport module reads the birthdate
claim and the name from fixed slots. Reordering these calls still yields a valid-looking proof, and
that proof never verifies.

**`range(d, d)`, not `eq(d)`.** Both give the date circuit the same bounds, so the birthdate
commitment is identical. But `@zkpassport/utils` also adds every field with an `eq` constraint to the
*disclose* mask, so `eq` folds the machine-readable date-of-birth characters into the name commitment.
The sealed name candidates cover the name alone. An `eq` proof from the right passport then fails with
"does not match the name and date of birth". This happened on the first live recovery, and
`app/test/zkPassportProver.test.ts` pins the query shape so it cannot happen again.

`scope` (`nihilium-vault`) and `devMode` live in one constant because
`request()` and `getSolidityVerifierParameters()` must agree on both.

`@zkpassport/sdk` is loaded with a dynamic `import()` on first use. It pulls in the Barretenberg
prover, which is several megabytes, and a page that never recovers should not load it.

## What it does not promise

- **Loss, not theft.** Someone holding the seed does not need this gate.
- **The key is assembled.** Recovery decrypts every record and spends the vault, exactly as the email
  method does.
- **The trust anchor never answers `valid`.** The fused resolver is an AND over DKIM and the passport
  resolver. The passport resolver always answers `unknown`, because this SDK does not check
  ZKPassport's certificate registry against an independent ICAO snapshot. So the combined answer is
  only ever `unknown` or `invalid`, and `unknown` must not be shown as all-clear.

## Requirements and status

- **Network.** Sepolia. The adapter's constructor refuses any network missing one of its five
  verifiers. `registry.ts` catches that refusal and turns it into the picker's reason for greying the
  method out, and the email method still works.
- **Versions.** `@zkpassport/sdk@0.16.2`, pinned. It and `@zkpassport/utils@0.37.5` are what
  nihilium-core's passport commitments are built against; 0.17 moves to utils 0.38. It declares a
  `typescript@^5` peer, which is why the root `.npmrc` sets `legacy-peer-deps`.
- **Unreleased SDK code.** The passport path needs `@nihilium/client-sdk` changes that no published
  release carries yet. The `file:` links resolve through the local `../recovery-sdk` and
  `../nihilium-core` checkouts, so this works here but not from npm.
- **Live status.** The SDK's fused adapter is covered by hermetic tests only, and this app is its
  first live run. `app/test/emailPassport.test.ts` covers this repo's side without a ceremony: the
  parsing, the stored gate, the free `addChain`, and the scan loop's link, mismatch, retry and clear.
  An end-to-end recovery needs one person holding the mailbox and the passport at the same time.
