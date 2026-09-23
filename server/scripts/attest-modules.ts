/**
 * Teach the ERC-7484 registry about this demo's modules. Run once per chain.
 *
 * **Why this exists at all.** Safe7579 routes every `installModule` through the Rhinestone
 * registry, and the registry refuses an account with no trusted attesters
 * (`NoTrustedAttestersFound`). Worse, the Safe7579 **launchpad** calls
 * `trustAttesters(threshold, attesters)` while the Safe is being set up, and the registry reverts
 * on an empty attester list (`InvalidTrustedAttesterInput`) — which surfaces as Safe's opaque
 * `GS000`, "could not finish initialization", from a transaction that looks like it should work.
 *
 * So a Safe7579 account **must** name at least one attester, and every module it installs must be
 * attested by one of them. Rhinestone attests its own modules; nobody has ever attested ours. This
 * script makes the demo's attester role vouch for both, which is the honest arrangement: the
 * registry is an opt-in trust layer, and this is us saying out loud whose word we take.
 *
 * It is idempotent — every step checks the chain first, so re-running costs one `eth_call` per step
 * and nothing else.
 *
 * **To replace:** everything. A real deployment trusts an attester it did not appoint, and ships
 * modules somebody independent has reviewed. Self-attestation proves the plumbing, not the module.
 * **Assumes:** the attester role holds gas on this chain, and that `RESOLVER_UID` is a resolver the
 * registry already knows — it is the one Rhinestone's own modules are registered under.
 */
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { config } from "../src/config.js";

/** ERC-7484's canonical registry. Same address on every chain that has one. */
const REGISTRY: Address = "0x000000000069E2a187AEFFb852bF3cCdC95151B2";

/**
 * The resolver Rhinestone's own modules are registered under.
 *
 * Reused rather than deployed: a resolver is the hook the registry calls on registration, and a
 * demo does not need its own. Read back from `findModule(OwnableValidator)`, so it is a fact about
 * this chain rather than a constant somebody copied.
 */
const RESOLVER_UID: Hex = "0xdbca873b13c783c0c9c6ddfc4280e505580bf6cc3dac83f8a0f7b44acaafca4f";

/** ERC-7579 module type ids. The attestation is per type, and an install checks the type it wants. */
const ZERO_UID: Hex = `0x${"00".repeat(32)}`;

const MODULE_TYPE_VALIDATOR = 1n;
const MODULE_TYPE_EXECUTOR = 2n;

/** Rhinestone's OwnableValidator — what a recovery installs to hand the account over. */
const OWNABLE_VALIDATOR: Address = "0x2483DA3A338895199E5e538530213157e931Bf06";

/** Enough to register a schema, register a module and make two attestations, with room. */
const MIN_ATTESTER_BALANCE = 20_000_000_000_000_000n; // 0.02 ETH

const registryAbi = [
    {
        type: "function",
        name: "registerSchema",
        inputs: [
            { name: "schema", type: "string" },
            { name: "validator", type: "address" },
        ],
        outputs: [{ type: "bytes32" }],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "findSchema",
        inputs: [{ name: "uid", type: "bytes32" }],
        outputs: [
            {
                type: "tuple",
                components: [
                    { name: "registeredAt", type: "uint48" },
                    { name: "validator", type: "address" },
                    { name: "schema", type: "string" },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "registerModule",
        inputs: [
            { name: "resolverUID", type: "bytes32" },
            { name: "moduleAddress", type: "address" },
            { name: "metadata", type: "bytes" },
            { name: "resolverContext", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "findModule",
        inputs: [{ name: "moduleAddress", type: "address" }],
        outputs: [
            {
                type: "tuple",
                components: [
                    { name: "resolverUID", type: "bytes32" },
                    { name: "sender", type: "address" },
                    { name: "metadata", type: "bytes" },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "attest",
        inputs: [
            { name: "schemaUID", type: "bytes32" },
            {
                name: "request",
                type: "tuple",
                components: [
                    { name: "moduleAddress", type: "address" },
                    { name: "expirationTime", type: "uint48" },
                    { name: "data", type: "bytes" },
                    { name: "moduleTypes", type: "uint256[]" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "findAttestation",
        inputs: [
            { name: "module", type: "address" },
            { name: "attester", type: "address" },
        ],
        outputs: [
            {
                type: "tuple",
                components: [
                    { name: "time", type: "uint48" },
                    { name: "expirationTime", type: "uint48" },
                    { name: "revocationTime", type: "uint48" },
                    { name: "moduleTypes", type: "uint32" },
                    { name: "moduleAddress", type: "address" },
                    { name: "attester", type: "address" },
                    { name: "dataPointer", type: "address" },
                    { name: "schemaUID", type: "bytes32" },
                ],
            },
        ],
        stateMutability: "view",
    },
] as const;

/**
 * The schema every attestation here references.
 *
 * Deliberately minimal. A schema describes how to decode an attestation's `data`, and this demo
 * attaches none — the claim is "this attester vouches for this module for these types", which the
 * registry records structurally.
 */
const SCHEMA = "string name";

/**
 * The uid the registry assigned that schema, **read from the chain, never computed.**
 *
 * The registry derives a schema uid from more than the schema string, so deriving it here produced
 * a plausible 32 bytes that pointed at nothing — `attest` then failed `InvalidSchema()` *after*
 * registration had already succeeded, which reads as a broken script rather than a wrong constant.
 * Pinned, and checked against `findSchema` before use.
 */
const SCHEMA_UID: Hex = "0xae8fe9deaf9d45b4cc92b39b99be8266fbc33a54c207e92be10a51cc5a5171e1";


async function main(): Promise<void> {
    const attester = config.roles.attester.on(config.namespace);
    const account = privateKeyToAccount(attester.privateKey);

    const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(config.rpcUrl),
    }) as PublicClient;
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(config.rpcUrl) });

    const moduleAddress = recoveryModuleAddress(config.chainId) as Address;

    console.log(`attester  ${account.address}`);
    console.log(`registry  ${REGISTRY}`);
    console.log(`modules   ${moduleAddress} (executor), ${OWNABLE_VALIDATOR} (validator)\n`);

    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < MIN_ATTESTER_BALANCE) {
        // Refused rather than attempted: a half-finished registry setup is harder to read than one
        // that never started, and the first failure would be an opaque out-of-gas.
        throw new Error(
            `The attester holds ${formatEther(balance)} ETH, below the ${formatEther(MIN_ATTESTER_BALANCE)} ` +
                `this needs. Send it some, or forward from the relayer: it is ${account.address}.`,
        );
    }

    async function send(label: string, data: Parameters<typeof wallet.writeContract>[0]): Promise<void> {
        const hash = await wallet.writeContract(data);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`  ${label}  tx=${receipt.transactionHash} (${receipt.status})`);
    }

    // 1. A schema to attest under. `findSchema` on a uid nobody registered returns a zero record.
    let schemaUID = SCHEMA_UID;
    const schema = await publicClient.readContract({
        address: REGISTRY,
        abi: registryAbi,
        functionName: "findSchema",
        args: [schemaUID],
    });
    if (schema.registeredAt === 0) {
        console.log("schema    registering");
        const hash = await wallet.writeContract({
            address: REGISTRY,
            abi: registryAbi,
            functionName: "registerSchema",
            args: [SCHEMA, "0x0000000000000000000000000000000000000000"],
            account,
            chain: sepolia,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // The uid comes off the event rather than being derived: see `SCHEMA_UID`.
        const registered = receipt.logs.find((entry) => entry.topics.length === 3);
        if (registered?.topics[1] === undefined) {
            throw new Error(
                `registerSchema landed in ${receipt.transactionHash} but emitted no uid. Read it ` +
                    "from the SchemaRegistered event and pin it as SCHEMA_UID.",
            );
        }
        schemaUID = registered.topics[1];
        console.log(`  registerSchema  tx=${receipt.transactionHash} uid=${schemaUID}`);
        if (schemaUID !== SCHEMA_UID) {
            console.log(`  NOTE: SCHEMA_UID in this file is stale; update it to ${schemaUID}`);
        }
    } else {
        console.log(`schema    already registered (${schemaUID.slice(0, 14)}…)`);
    }

    // 2. The recovery module has to be known to the registry before it can be attested.
    for (const [label, address] of [
        ["RecoveryModule", moduleAddress],
        ["OwnableValidator", OWNABLE_VALIDATOR],
    ] as const) {
        const record = await publicClient.readContract({
            address: REGISTRY,
            abi: registryAbi,
            functionName: "findModule",
            args: [address],
        });
        // Keyed on `resolverUID`, not `sender`: `registerModule` leaves `sender` zero and only
        // `deployModule` sets it, so a sender check reports every registered module as missing and
        // then fails `AlreadyRegistered` on the retry.
        if (record.resolverUID === ZERO_UID) {
            console.log(`module    ${label} registering`);
            await send("registerModule", {
                address: REGISTRY,
                abi: registryAbi,
                functionName: "registerModule",
                args: [RESOLVER_UID, address, "0x", "0x"],
                account,
                chain: sepolia,
            });
        } else {
            const by = record.sender === "0x0000000000000000000000000000000000000000"
                ? "registerModule"
                : `deployModule by ${record.sender}`;
            console.log(`module    ${label} already registered (${by})`);
        }
    }

    // 3. The attestations themselves, one per module, each naming the type it covers. An install
    //    checks the type it wants, so an executor attestation does not license a validator.
    for (const [label, address, moduleType] of [
        ["RecoveryModule", moduleAddress, MODULE_TYPE_EXECUTOR],
        ["OwnableValidator", OWNABLE_VALIDATOR, MODULE_TYPE_VALIDATOR],
    ] as const) {
        const existing = await publicClient.readContract({
            address: REGISTRY,
            abi: registryAbi,
            functionName: "findAttestation",
            args: [address, account.address],
        });
        if (existing.time !== 0 && existing.revocationTime === 0) {
            console.log(`attest    ${label} already attested`);
            continue;
        }
        console.log(`attest    ${label} as type ${moduleType}`);
        await send("attest", {
            address: REGISTRY,
            abi: registryAbi,
            functionName: "attest",
            args: [
                schemaUID,
                // `expirationTime: 0` is "never expires". A demo attestation that lapsed mid-run
                // would fail an install with an error naming nothing.
                { moduleAddress: address, expirationTime: 0, data: "0x", moduleTypes: [moduleType] },
            ],
            account,
            chain: sepolia,
        });
    }

    console.log(`\nDone. Set VITE_MODULE_ATTESTER=${account.address} in app/.env.local.`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
