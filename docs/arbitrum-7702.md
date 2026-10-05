# Arbitrum Sepolia: recovery for a plain EOA, through EIP-7702

Sepolia in this demo protects a **Safe**: the recovery module is installed on a smart account the
user had to move into. Arbitrum Sepolia protects the account the user **already has**. The EOA
delegates its code to `Eip7702RecoveryAccount` once, and from then on it is the recovery account.
There is no migration, no bundler and no counterfactual address.

This page covers how this repo wires that. The contract and its rules are in
[`../recovery-sdk/docs/arbitrum-7702.md`](../recovery-sdk/docs/arbitrum-7702.md). The seal, the
ceremony and the vault are the same as on every other chain: Arbitrum is one more chain in the same
vault, and adding it is free.

| | file |
|---|---|
| the chain | [`app/src/integration/chains/arbitrumSepolia.ts`](../app/src/integration/chains/arbitrumSepolia.ts) |
| reads, at the EOA's address | [`settlement/eip7702/reads.ts`](../app/src/integration/recovery/settlement/eip7702/reads.ts) |
| refusals, before anything is signed | [`settlement/eip7702/preflight.ts`](../app/src/integration/recovery/settlement/eip7702/preflight.ts) |
| delegate, then register | [`settlement/eip7702/register.ts`](../app/src/integration/recovery/settlement/eip7702/register.ts) |
| initiate, execute, sweep, abort | [`recovery/handover/eip7702.ts`](../app/src/integration/recovery/handover/eip7702.ts) |
| the relayer | [`server/src/roles/relayer/eip7702.ts`](../server/src/roles/relayer/eip7702.ts) |

## The account is its own contract

After delegation, `address(this)` is the EOA and the recovery state lives in the EOA's own storage.
Two consequences run through every file above:

- **Every call goes to the EOA's address.** Reads, `register`, `initiateRecovery`, `execute`, all of
  them. The implementation address (`eip7702AccountAddress(421614)`) is only what the EOA delegates
  *to*. A call aimed at it reads an empty account.
- **The EIP-712 domain's `verifyingContract` is the EOA.** That is why every digest is read from the
  account (`hashRegister`, `hashIntent`, `hashExecute`) and never built locally. The domain also
  carries `version()`, which moved from 1.0.0 to 1.1.0 when `receive()` was added. A hand-built
  digest would still be signing for the old one.

`ChainContext.accountId` is the EOA, and `DerivedAccount.address` is the same string. The key is
`m/44'/60'/0'/0/0`, the one that owns the Sepolia Safe. That is safe because the namespace differs:
`eip155:421614` is a KDF input, so the recovery key is unrelated to Sepolia's.

## Protecting: two transactions, both the wallet's

1. **Refuse what cannot be undone.** A 7702 authorization is valid only if signed by the EOA's own
   key, so an owner who has lost it can never re-point the code. Before signing, `preflightProtect`
   refuses two things:
   - an implementation that cannot receive ETH. It sends 1 wei in an `eth_call`, which is exactly
     what v1.0.0 failed.
   - an EOA already delegated to somebody else's code.
2. **Delegate.** The EOA signs an authorization with `executor: "self"` and sends a type-4
   transaction to itself. The calldata is `isRegistered()`, a view, so the transaction cannot
   revert.
3. **Register.** `hashRegister` cannot be read before the code exists, hence the separate
   transaction. The contract wants two signatures over that digest:
   - the **incoming recovery key**, so the root is minted in `protectOn7702`, used for one signature
     and wiped, exactly as on Solana;
   - the **current owner**, the EOA itself, so nobody can bind a recovery key to an account that did
     not agree.

`reg.nonce` is `configNonce`, never the recovery nonce. A re-protect after replacing guardians is the
same `register` call with the next `configNonce`: no uninstall step and no second delegation.

The wallet pays for both transactions. Abort is the EOA itself. `abort()` checks the sender, and the
EOA can call its own address.

## Recovering: the relayer submits everything

| step | signed by | sent by |
|---|---|---|
| `initiateRecovery(intent, sig)` | the recovered key, over `hashIntent` | relayer |
| `executeRecovery(intent)` | nobody: the timelock is the authority | relayer |
| `execute([{to, value, "0x"}], expiry, sig)` | the new owner, over `hashExecute` | relayer |

`executeRecovery` sets the stored `owner` to the intent's `newOwner`. The sweep is `execute` signed by
that key. The relayer pays the gas and the value comes out of the EOA's own balance, so the whole
balance moves and nothing is reserved, unlike the Safe path.

**What recovery does not do.** It cannot stop the EOA's original key from sending ordinary
transactions: a protocol-level key is outside any contract's reach. That is the loss-not-theft line in
its plainest form. Recovery restores access to an owner who lost the key. It does not defend an
account whose key someone else holds.

## Fees

The fee table (`integration/costs/work.ts`) prices Arbitrum steps at Arbitrum One's gas price, not
mainnet's; the same gas on L1 costs about a hundred times more. The gas figures come from a local
anvil run of these modules, and stay marked *assumed* until they are replaced by Arbitrum receipts,
which add an L1 data charge on top.

| step | execution gas |
|---|---|
| delegate | 38,782 |
| register (first) | 272,485 |
| register (rotation) | 76,295 |
| initiateRecovery | 105,701 |
| executeRecovery | 87,434 |
| execute (sweep to a fresh account) | 93,014 |

## Running it

- **App:** `VITE_ARBITRUM_SEPOLIA_RPC_URL` defaults to the public RPC.
- **Server:** `ARBITRUM_SEPOLIA_RPC_URL` defaults to the public RPC too, and the routes mount at
  `/api/roles/relayer/arbitrum`. The roles have the same addresses as on Sepolia (same path, same
  phrase). The relayer needs a little Arbitrum Sepolia ETH; the boot banner prints its balance and a
  faucet.
- **Wallet:** fund the EOA shown on the Arbitrum tab. Protect all then offers the chain. The first
  protect sends two transactions, and every later one sends one.
