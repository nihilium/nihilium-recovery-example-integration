import { useEffect, useState } from "react";
import { PAYMENT_TOKEN_PATH } from "@nihilium/recovery-core";

/**
 * Whether this app's server can pay for a seal: `true`, `false`, or `null` while unknown.
 *
 * The API key lives on the server, so the bundle cannot tell by itself. The payment route is
 * mounted only when the server has a key, and answers anything but `POST` with a 405, so a `GET`
 * tells the two apart without spending: 405 is mounted, 404 is not. It goes through `/api/` like
 * every other call, which is all nginx forwards in the deployment. Anything else, an unreachable
 * server included, stays `null`: it is not evidence of a missing key.
 */
export function useServerPayments(serverUrl: string): boolean | null {
    const [payments, setPayments] = useState<boolean | null>(null);
    useEffect(() => {
        let live = true;
        fetch(`${serverUrl.replace(/\/+$/, "")}${PAYMENT_TOKEN_PATH}`)
            .then((res) => {
                if (!live) return;
                if (res.status === 405) setPayments(true);
                else if (res.status === 404) setPayments(false);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [serverUrl]);
    return payments;
}
