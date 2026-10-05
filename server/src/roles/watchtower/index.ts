/**
 * The watchtower: notices a recovery that somebody else started, and says so to whoever asks.
 *
 * `@nihilium/recovery-watchtower` behind Express. It watches two planes, both polled:
 *
 * - **Off-chain:** the reveal values a Nihilium unseal publishes to the datastream *before* any
 *   proof and before anything reaches a chain. This fires while a hostile recovery is still in the
 *   ceremony, which is the whole reason a watchtower is worth running.
 * - **On-chain:** the recovery module's attempt state, which gives the countdown.
 *
 * **What it holds and what it can do.** Watches: targets, their last verdicts, and the hash of each
 * watch's manage credential. No keys and no write path to any chain. It notices; it cannot act. The
 * user acts, with abort, from the wallet.
 *
 * **What the operator learns.** That a vault exists, which processor cohort protects it, and, with
 * an on-chain target, which account. One watch covering both planes ties those together. That is
 * the privacy price of opting in, and it belongs in a real wallet's onboarding copy.
 *
 * **A broken watcher is not a quiet one.** The SDK's statuses are tri-state and a fresh watch reads
 * `never-polled`, never clear. Nothing here softens that: statuses are forwarded verbatim.
 *
 * **To replace:** the shared registration secret, which a real operator issues per tenant; and
 * `POST /poll`, a demo affordance the SDK deliberately does not have. **Assumes:** the host runs
 * `poll()` on a timer (`startPolling`); the package never runs its own loop.
 */
import { Router, type Request, type Response } from "express";
import {
    WATCH_CREDENTIAL_HEADER,
    WATCH_MANAGE_HEADER,
    WatchtowerService,
    sharedSecretRegister,
} from "@nihilium/recovery-watchtower";
import { hashCredential, type WatchProbe, type WatchStore } from "@nihilium/recovery-core";

export interface WatchtowerDeps {
    store: WatchStore;
    probes: readonly WatchProbe[];
    /** The operator's registration secret. Only its hash is held. */
    registerSecret: string;
    pollIntervalSeconds: number;
    /** Adds `POST /poll`. Off in production: the SDK's API deliberately lacks it. */
    allowForcedPoll: boolean;
    log: (message: string) => void;
}

export interface Watchtower {
    router: Router;
    service: WatchtowerService;
    /** Start the poll loop. Returns a stop function. */
    startPolling(): () => void;
}

export function createWatchtower(deps: WatchtowerDeps): Watchtower {
    const service = new WatchtowerService({
        store: deps.store,
        probes: deps.probes,
        register: sharedSecretRegister([hashCredential(deps.registerSecret)]),
        pollIntervalSeconds: deps.pollIntervalSeconds,
    });

    const router = Router();

    // `handle()` is the service's own router: the routes, the caps and the 404 for listing are the
    // SDK's, not re-implemented here.
    const forward = async (req: Request, res: Response) => {
        const { status, body } = await service.handle({
            method: req.method,
            path: req.path,
            headers: req.headers as Record<string, string>,
            body: req.body,
        });
        if (req.method !== "GET") deps.log(`${req.method} ${req.path.slice(0, 18)}… -> ${status}`);
        res.status(status);
        if (body === null || body === undefined) res.end();
        else res.json(body);
    };

    if (deps.allowForcedPoll) {
        // Registered before the catch-all so `/poll` is never read as a watch id.
        router.post("/poll", (_req, res, next) => {
            void poll()
                .then((report) => res.json(report))
                .catch(next);
        });
    }
    router.all(/^\/watches(\/.*)?$/, (req, res, next) => void forward(req, res).catch(next));

    let running: Promise<unknown> | null = null;
    /** One cycle at a time: a forced poll during a timed one joins it rather than doubling up. */
    function poll() {
        running ??= service.poll().finally(() => {
            running = null;
        });
        return running as ReturnType<WatchtowerService["poll"]>;
    }

    return {
        router,
        service,
        startPolling() {
            const tick = () => {
                poll()
                    .then((report) => {
                        if (report.tripped.length > 0 || report.unknown > 0) {
                            deps.log(
                                `poll: ${report.watchesPolled} watches, ${report.targetsProbed} targets, ` +
                                    `${report.tripped.length} tripped, ${report.unknown} unknown`,
                            );
                        }
                    })
                    // Logged, never thrown: a poll that fails leaves every status aging into
                    // `degraded`, which is the loud outcome the SDK designs for.
                    .catch((error: unknown) => deps.log(`poll failed: ${String(error)}`));
            };
            tick();
            const timer = setInterval(tick, deps.pollIntervalSeconds * 1000);
            return () => clearInterval(timer);
        },
    };
}

export { WATCH_CREDENTIAL_HEADER, WATCH_MANAGE_HEADER };
