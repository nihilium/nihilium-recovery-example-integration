/**
 * A `ConditionAdapter` that stands in for a real identity ceremony, so the whole app runs offline,
 * instantly and for nothing — with every *other* part of the SDK real.
 *
 * Modelled on `DemoCondition` in the SDK's `examples/quorum-recovery.mjs`, with two deliberate
 * differences:
 *
 * 1. **It does real asymmetric crypto** rather than hex-encoding the record. That matters beyond
 *    tidiness: with hex, the record host would hold plaintext root secrets, and this demo's "look at
 *    exactly what a provider can see" lesson would be a lie.
 * 2. **It waits for a human**, through `onHumanStep`. A real ceremony mails someone and long-polls
 *    until they reply; here the same pause surfaces as a prompt the scenario runner renders. Skipping
 *    it would hide the single most important property of recovery: it is slow and human-in-the-loop.
 *
 * The shape of the fake is the shape of the real thing: `sealVault` is the expensive once-per-vault
 * step and holds nothing but its own keypair, while `sealRecord` is a local encryption to a public
 * key that needs no ceremony, no payment and no network.
 *
 * **To replace:** the whole file — swap it for `ZKEmailConditionAdapter` and nothing else moves; see
 * `../registry.ts`, which is the only file that chooses.
 * **Assumes:** WebCrypto (browser, or Node 18+) and that nobody mistakes it for a security boundary:
 * the seal here protects the vault key behind *nothing at all*, which is exactly what the live
 * adapter's ceremony replaces.
 *
 * **Used by the test suite only.** The app runs the live `ZKEmailConditionAdapter`; this stands
 * in for it so the tests stay offline and free.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
    RecoverySdkError,
    type ChainContext,
    type Condition,
    type ConditionAdapter,
    type ConditionProof,
    type RecordId,
    type SealBlob,
    type SealPublicComponent,
    type SealedRecord,
    type TrustAnchorResolver,
    type VaultSeal,
} from "@nihilium/recovery-core";

export const DEMO_VAULT_FORMAT = "demo-email-vault-v1";
export const DEMO_RECORD_FORMAT = "demo-email-record-v1";

/** What the scenario runner is handed when this adapter reaches the point a human must act. */
export interface HumanStep {
    email: string;
    /** Masked: `a…e@gmail.com`. What a progress line may show. */
    maskedEmail: string;
}

export interface DemoEmailConditionOptions {
    /**
     * Awaited where a live ceremony would be waiting on a reply. Resolve to continue, reject to fail
     * this member. Omitted, the pause is skipped — which is what the conformance tests want and what
     * a scenario never does.
     */
    onHumanStep?: (step: HumanStep) => Promise<void>;
    /** Flipped by the demo to make a guardian unreachable, so a failed quorum can be shown. */
    reachable?: boolean;
}

interface DemoVaultPayload {
    v: 1;
    /**
     * In the clear, matching the real zkEmail adapter, which records the address so a recovery needs
     * nothing but the seal file. It is also why a quorum seal discloses the whole recovery social
     * graph to whoever holds it — a property worth demonstrating rather than papering over.
     */
    email: string;
    recordId: RecordId;
    /** The vault's private half. In a live seal this sits behind the identity ceremony. */
    vaultPrivHex: string;
    vaultPubHex: string;
}

interface DemoRecordPayload {
    v: 1;
    ephPubHex: string;
    nonceHex: string;
    ciphertextHex: string;
}

/** Everything a caller may observe about this member without reaching into it. */
export interface DemoMemberStats {
    /** Sealing ceremonies run. One per `sealVault`. */
    ceremonies: number;
    /** Recovery ceremonies run. Stays 0 for a member a k-of-n recovery never contacted. */
    recoveries: number;
    reachable: boolean;
}

const permissiveResolver: TrustAnchorResolver = {
    rejectWeakSelectors: true,
    revocationFreshnessBlocks: 100,
    async resolve() {
        return { status: "valid", reason: "simulated ceremony", revoked: "no", strength: "ok" };
    },
};

export class DemoEmailConditionAdapter implements ConditionAdapter {
    readonly conditionType = "zkemail" as const;
    readonly resolver = permissiveResolver;

    private ceremonies = 0;
    private recoveries = 0;
    reachable: boolean;

    constructor(private readonly options: DemoEmailConditionOptions = {}) {
        this.reachable = options.reachable ?? true;
    }

    stats(): DemoMemberStats {
        return { ceremonies: this.ceremonies, recoveries: this.recoveries, reachable: this.reachable };
    }

    async buildCondition(params: unknown): Promise<Condition> {
        const email = requireEmail(params);
        return {
            conditionType: this.conditionType,
            descriptor: { email },
            // Domain-only, exactly as the live adapter's is: a summary travels with the public
            // component, and naming the address there would disclose a guardian.
            summary: `Control of an email address at ${domainOf(email)}`,
        };
    }

    async buildProof(params: unknown): Promise<ConditionProof> {
        return { conditionType: this.conditionType, descriptor: params ?? {} };
    }

    async sealVault(params: {
        condition: Condition;
        recordId: RecordId;
        /** Where the records will live, recorded on the seal. This demo store has no hosts. */
        recordHosts?: readonly string[];
        onProgress?: (message: string) => void;
    }): Promise<VaultSeal> {
        this.ceremonies += 1;
        const email = requireEmail(params.condition.descriptor);
        params.onProgress?.(`sealing a vault for ${maskEmail(email)}`);

        const vaultPriv = x25519.utils.randomSecretKey();
        const payload: DemoVaultPayload = {
            v: 1,
            email,
            recordId: params.recordId,
            vaultPrivHex: bytesToHex(vaultPriv),
            vaultPubHex: bytesToHex(x25519.getPublicKey(vaultPriv)),
        };
        const seal: SealBlob = { format: DEMO_VAULT_FORMAT, payload };
        return { seal, publicComponent: this.publicComponentOf(seal) };
    }

    async sealRecord(params: {
        publicComponent: SealPublicComponent;
        record: Uint8Array;
    }): Promise<SealedRecord> {
        const vaultPub = hexToBytes(publicPayload(params.publicComponent).vaultPubHex);
        const ephPriv = x25519.utils.randomSecretKey();
        const key = await aesKey(x25519.getSharedSecret(ephPriv, vaultPub));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(
            // Copied rather than passed straight through: a `Uint8Array` may be backed by a
            // SharedArrayBuffer, which WebCrypto refuses, and the copy is the cheap way to be sure
            // this one is not.
            await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(params.record)),
        );
        const payload: DemoRecordPayload = {
            v: 1,
            ephPubHex: bytesToHex(x25519.getPublicKey(ephPriv)),
            nonceHex: bytesToHex(nonce),
            ciphertextHex: bytesToHex(ciphertext),
        };
        return { format: DEMO_RECORD_FORMAT, payload };
    }

    /**
     * Built as a **whitelist**, never by copying the seal and deleting fields.
     *
     * The SDK's `sealPublicComponentConformance` suite serializes this whole object and scans it for
     * the secrets an implementation declares — at any depth. A delete-based projection passes until
     * someone adds a field, which is the moment nobody is looking.
     */
    publicComponentOf(seal: SealBlob): SealPublicComponent {
        const payload = vaultPayload(seal);
        return {
            format: DEMO_VAULT_FORMAT,
            recordId: payload.recordId,
            conditionType: this.conditionType,
            conditionSummary: `Control of an email address at ${domainOf(payload.email)}`,
            // Note what is absent: the address, and the vault's private half.
            payload: { recordId: payload.recordId, vaultPubHex: payload.vaultPubHex },
        };
    }

    async openRecords(params: {
        proof: ConditionProof;
        seal: SealBlob;
        chain: ChainContext;
        records: readonly SealedRecord[];
        onProgress?: (message: string) => void;
    }): Promise<Uint8Array[]> {
        this.recoveries += 1;
        const payload = vaultPayload(params.seal);
        // The quorum hands each member its own `buildProof` params back as that member's proof
        // descriptor, so this is where per-member callbacks arrive — already attributed, with no
        // `[member #N]` prefix to parse off a merged log.
        const member = (params.proof.descriptor ?? {}) as {
            onProgress?: (message: string) => void;
            onPhase?: (phase: { kind: string; message: string }) => void;
        };
        const report = (message: string, kind: "requesting" | "awaiting-human" | "proving" | "done") => {
            params.onProgress?.(message);
            member.onProgress?.(message);
            member.onPhase?.({ kind, message });
        };

        if (!this.reachable) {
            throw new RecoverySdkError(
                `No reply from ${maskEmail(payload.email)}. This guardian cannot complete a ceremony.`,
            );
        }

        report(`recovery email sent to ${maskEmail(payload.email)}`, "awaiting-human");
        // Where a live ceremony blocks on a human. The runner turns this into a prompt; a test
        // leaves `onHumanStep` unset and the pause simply is not there.
        await this.options.onHumanStep?.({ email: payload.email, maskedEmail: maskEmail(payload.email) });
        report("reply received, producing proof", "proving");

        const vaultPriv = hexToBytes(payload.vaultPrivHex);
        try {
            const out: Uint8Array[] = [];
            for (const record of params.records) {
                const recordPayload = recordPayloadOf(record);
                const key = await aesKey(
                    x25519.getSharedSecret(vaultPriv, hexToBytes(recordPayload.ephPubHex)),
                );
                const plaintext = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: hexToBytes(recordPayload.nonceHex) },
                    key,
                    hexToBytes(recordPayload.ciphertextHex),
                );
                out.push(new Uint8Array(plaintext));
            }
            // Positional, matching `records`: `selectEnvelope` scans all of them and a reordering
            // here would hand the SDK another chain's envelope.
            return out;
        } finally {
            vaultPriv.fill(0);
        }
    }
}

/** Bytes, not a string: @noble/hashes v2 rejects a string `info` rather than encoding it for you. */
const RECORD_KDF_INFO = new TextEncoder().encode("nihilium-demo-record-v1");

async function aesKey(shared: Uint8Array): Promise<CryptoKey> {
    // HKDF rather than the raw shared secret: the x25519 output is a curve point, not a uniform key.
    const derived = hkdf(sha256, shared, undefined, RECORD_KDF_INFO, 32);
    return crypto.subtle.importKey("raw", derived as BufferSource, "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);
}

function requireEmail(params: unknown): string {
    const email = (params as { email?: unknown } | undefined)?.email;
    if (typeof email !== "string" || !email.includes("@")) {
        throw new RecoverySdkError(`This condition needs an email address, got ${String(email)}.`);
    }
    return email;
}

function vaultPayload(seal: SealBlob): DemoVaultPayload {
    if (seal.format !== DEMO_VAULT_FORMAT) {
        throw new RecoverySdkError(
            `Seal format "${seal.format}" is not a simulated email vault. A vault sealed live cannot ` +
                "be opened in simulated mode, and the reverse.",
        );
    }
    return seal.payload as DemoVaultPayload;
}

function publicPayload(component: SealPublicComponent): { vaultPubHex: string } {
    return component.payload as { vaultPubHex: string };
}

function recordPayloadOf(record: SealedRecord): DemoRecordPayload {
    if (record.format !== DEMO_RECORD_FORMAT) {
        throw new RecoverySdkError(`Record format "${record.format}" was not written by this adapter.`);
    }
    return record.payload as DemoRecordPayload;
}

export function domainOf(email: string): string {
    return email.split("@").pop() ?? email;
}

/** `alice@gmail.com` -> `a…e@gmail.com`. For progress lines, which are not private. */
export function maskEmail(email: string): string {
    const [local = "", domain = ""] = email.split("@");
    const masked = local.length <= 2 ? `${local.slice(0, 1)}…` : `${local[0]}…${local.at(-1)}`;
    return `${masked}@${domain}`;
}
