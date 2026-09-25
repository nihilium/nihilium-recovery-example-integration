/**
 * The record host: a vault's encrypted records, and the context each chain needs to be recovered.
 *
 * `@nihilium/recovery-service` behind Express, unchanged. Reading is `GET /records/:id` with no
 * credential — a record id is 120 unguessable bits and its own read capability. Appending is
 * `POST /records/:id` with the append credential, because an add-only store cannot delete and a
 * read capability that also wrote would make a leaked id a permanent junk-injection vector.
 *
 * **What this host can see.** The ciphertext is inert without the seal, which never comes here. But
 * this demo also stores each chain's *context* here — the chain, the account, the epoch, the
 * registered recovery key — as plain JSON entries next to the ciphertext, tagged
 * `nihilium-demo-chain-context-v1`. That is a deliberate trade: it lets a seal file downloaded once
 * recover chains added after it, *and* lets the app check those chains on-chain before a paid
 * ceremony. The cost is that this host learns which accounts a vault protects. The service itself
 * never inspects a record's format, so the SDK's guarantee about the ciphertext is unchanged; the
 * disclosure is this app's choice, not the service's.
 *
 * **To replace:** `store`, with whatever durable storage the provider runs, and `appendSecret` with
 * per-record credentials (`sharedSecretAppend`) minted at seal time. One shared secret is a demo
 * convenience: it authorizes appends to every record at once.
 * **Assumes:** the caller treats this host as a replica. Losing these records loses the recovery
 * even with the seal in hand.
 */
import { Router, type Request, type Response } from "express";
import {
    APPEND_CREDENTIAL_HEADER,
    RecoveryDataService,
    type AppendAuthorizer,
} from "@nihilium/recovery-service";
import {
    ServiceError,
    constantTimeEquals,
    hashCredential,
    type SealedDataStore,
} from "@nihilium/recovery-core";

export interface RecordsDeps {
    store: SealedDataStore;
    /** One secret for every record. See the header for why that is a demo shortcut. */
    appendSecret: string;
    log: (message: string) => void;
}

export function createRecordsRouter(deps: RecordsDeps): Router {
    const service = new RecoveryDataService({
        store: deps.store,
        append: singleSecretAppend(deps.appendSecret),
    });

    const router = Router();

    // `handle()` is the service's own router, so the routes, the size caps and the "unknown id reads
    // as empty" rule are the SDK's and not re-implemented here.
    const forward = async (req: Request, res: Response) => {
        const { status, body } = await service.handle({
            method: req.method,
            path: req.path,
            headers: req.headers as Record<string, string>,
            body: req.body,
        });
        if (req.method === "POST") {
            // The record id only: it is a read capability, and a log line holding one is a log line
            // that can read the ciphertext. Truncated so the line still identifies the request.
            deps.log(`append ${req.params["id"]?.slice(0, 8) ?? "?"}… -> ${status}`);
        }
        res.status(status);
        if (body === null) res.end();
        else res.json(body);
    };

    router.get("/records/:id", (req, res, next) => void forward(req, res).catch(next));
    router.post("/records/:id", (req, res, next) => void forward(req, res).catch(next));
    return router;
}

/**
 * Authorizes an append by one secret, for any record.
 *
 * Only the hash is held, and compared in constant time — the same discipline as the service's own
 * `sharedSecretAppend`, minus the per-record map this demo has no step to populate.
 */
function singleSecretAppend(secret: string): AppendAuthorizer {
    const expected = hashCredential(secret);
    return {
        authorize({ credential }) {
            if (credential === undefined || !constantTimeEquals(hashCredential(credential), expected)) {
                throw new ServiceError(403, "Not authorized to append to this record.");
            }
        },
    };
}

export { APPEND_CREDENTIAL_HEADER };
