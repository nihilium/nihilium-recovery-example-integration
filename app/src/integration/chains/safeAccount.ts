/**
 * One Safe smart account, built the same way everywhere it is needed.
 *
 * Three callers must agree on it — deriving the address for the wallet card, sending value, and
 * installing the recovery module. If they built it differently they would be addressing two
 * different accounts while appearing to address one, and the second would quietly be a
 * counterfactual address with no funds and no module. So the construction lives here once and
 * `deriveAccounts` imports it rather than repeating it.
 *
 * **This is a Safe with the Safe7579 adapter, not a plain Safe.** An ordinary Safe has no ERC-7579
 * surface at all: no `installModule`, nothing the recovery module could be installed as. The adapter
 * is set up as the Safe's fallback handler and module by the launchpad, and from then on calls to
 * the Safe's address that carry a 7579 selector land on it. That is why `erc7579LaunchpadAddress` is
 * not optional here — without it `permissionless` builds a perfectly good Safe that this repo's
 * entire settlement layer cannot touch.
 *
 * **The fee callback is not optional.** A bundler rejects a UserOp with no `maxFeePerGas` /
 * `maxPriorityFeePerGas`, viem does not fill them in, and the rejection arrives disguised as
 * `eth_estimateUserOperationGas does not exist / is not available` with the real validation error
 * buried underneath — so it reads as an unsupported bundler rather than an incomplete operation.
 *
 * **To replace:** the whole file, with whatever provisions your smart accounts. Nothing above the
 * `client` it returns cares whether that is permissionless, Rhinestone or a factory of your own.
 * **Assumes:** the demo's private-key export. A real app holds a signer and never sees bytes.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";

/**
 * Pinned, and pinned in one place. The account's address derives from this: changing it moves the
 * account, stranding whatever the old one held and whatever module it had installed.
 *
 * 1.4.1 rather than the newer 1.5.0, which is not a preference — `toSafeSmartAccount` throws
 * outright when 1.5.0 is combined with the 7579 launchpad.
 */
export const SAFE_VERSION = "1.4.1" as const;

/**
 * Rhinestone's Safe7579 adapter and launchpad, v1.0.0. CREATE2-deployed, so these are the same
 * addresses on every chain that has them; both are verified present on Sepolia.
 *
 * The launchpad exists because a Safe cannot be both deployed and 7579-initialised in one
 * `setup()`: the proxy is pointed at the launchpad first, which validates the deploying UserOp,
 * installs the modules and only then swaps in the real Safe singleton.
 */
export const SAFE7579_ADAPTER: Address = "0x7579EE8307284F293B1927136486880611F20002";
export const SAFE7579_LAUNCHPAD: Address = "0x7579011aB74c46090561ea277Ba79D510c6C00ff";

export interface SafeAccountOptions {
    rpcUrl: string;
    bundlerUrl: string;
    /** Demo-only. See the header. */
    ownerPrivateKeyHex: string;
    /** See `toDemoSafeAccount`. Changing it moves the account. */
    attester: Address;
}

/** `0x`-prefix whatever the demo's key export handed us. */
function toHexKey(raw: string): Hex {
    return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

/**
 * The account on its own, with no bundler attached.
 *
 * `deriveAccounts` needs nothing but the address, and building a bundler client to get one would
 * make every wallet render depend on a bundler being reachable.
 */
export async function toDemoSafeAccount(params: {
    client: PublicClient;
    ownerPrivateKeyHex: string;
    /**
     * Whose word this account takes about module code.
     *
     * **Not optional, and not cosmetic.** Safe7579 routes every `installModule` through the ERC-7484
     * registry, and the launchpad calls `trustAttesters(threshold, attesters)` while the Safe is
     * being set up. The registry rejects an empty attester list, so an account naming none cannot be
     * deployed at all — it fails as Safe's `GS000`, "could not finish initialization", which points
     * nowhere near the registry. An account naming one but leaving the threshold at 0 deploys and
     * then cannot install anything (`NoTrustedAttestersFound`).
     *
     * This address is also part of the account's **address**: it is hashed into the setup data and
     * therefore the CREATE2 salt. Changing it moves the account, which moves
     * `ChainContext.accountId`, which orphans every vault sealed against the old one.
     */
    attester: Address;
}) {
    const owner = privateKeyToAccount(toHexKey(params.ownerPrivateKeyHex));

    return toSafeSmartAccount({
        client: params.client,
        owners: [owner],
        entryPoint: { address: entryPoint07Address, version: "0.7" },
        version: SAFE_VERSION,
        // Not a mistake, and not the Safe 4337 module. `permissionless` reuses this parameter as
        // the `safe7579` address once a launchpad is given; passing the real 4337 module here
        // yields a plausible account that no 7579 module can ever be installed on.
        safe4337ModuleAddress: SAFE7579_ADAPTER,
        erc7579LaunchpadAddress: SAFE7579_LAUNCHPAD,
        attesters: [params.attester],
        // 1, never 0. The registry treats a zero threshold as "no attesters configured" and refuses
        // every install. With 1, `_check` returns on the first attester holding a valid attestation
        // for the module being installed — so one attester covering both modules is enough, and
        // adding more is additive rather than conjunctive.
        attestersThreshold: 1,
    });
}

/**
 * The bundler's own price, with the chain's estimate as a fallback.
 *
 * Exported because the recovered-owner client needs the identical behaviour and a second copy of
 * this would be a second thing to get wrong. See the header for why it exists at all.
 */
export function bundlerFeeEstimator(publicClient: PublicClient, bundlerUrl: string) {
    // `pimlico_getUserOperationGasPrice` is not standard, so a bundler without it falls through to
    // the chain's estimate rather than failing.
    const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });

    return async () => {
        try {
            return (await pimlico.getUserOperationGasPrice()).fast;
        } catch {
            const fees = await publicClient.estimateFeesPerGas();
            return {
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            };
        }
    };
}

export async function createSafeClient(options: SafeAccountOptions) {
    const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(options.rpcUrl),
    }) as PublicClient;

    const account = await toDemoSafeAccount({
        client: publicClient,
        ownerPrivateKeyHex: options.ownerPrivateKeyHex,
        attester: options.attester,
    });

    const client = createSmartAccountClient({
        account,
        chain: sepolia,
        bundlerTransport: http(options.bundlerUrl),
        userOperation: {
            // Ask the bundler for its own prices — it is the party deciding what it will accept.
            estimateFeesPerGas: bundlerFeeEstimator(publicClient, options.bundlerUrl),
        },
    });

    return { publicClient, account, client };
}
