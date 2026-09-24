/**
 * What a transaction costs in dollars, read from Ethereum mainnet.
 *
 * This app runs on Sepolia and devnet, where gas is free and the token is worthless — so a fee
 * quoted from the chains it actually uses would be a number near zero, which is the one answer that
 * teaches nothing. The *work* comes from the testnets (see `work.ts`); the *price* comes from here,
 * and the two being different places is the point rather than an inconsistency to tidy away.
 *
 * Chainlink rather than a price API because it needs no key and no rate limit — and because
 * `latestRoundData` carries `updatedAt`, so a stale answer is reported as stale instead of passing
 * for live.
 *
 * **Two chains, because one feed was stale by design.** The base fee and ETH/USD come from Ethereum
 * mainnet. SOL/USD comes from **Arbitrum**: the same Chainlink feed on Ethereum updates only on a
 * ~24h heartbeat or a large enough move, and was measured 21 hours old — while its Arbitrum
 * counterpart, same interface, was three minutes old.
 *
 * **To replace:** the feed addresses, if you price other chains — Chainlink publishes the same
 * interface for most majors, and `readMainnetPrices` cares only about `latestRoundData`. Replace the
 * whole file if you have a price source of your own; nothing downstream knows where these came from
 * except through `asOfSeconds`.
 * **Assumes:** `ethereum` points at **Ethereum mainnet** and `arbitrum` at **Arbitrum One**. Against
 * any other chain the feed calls return no data and this throws. It does not consult Arbitrum's
 * sequencer-uptime feed, which a contract settling against this price must; an estimate shown
 * beside a button can live with the rare sequencer outage, and the age it reports still tells.
 */
import type { Address, PublicClient } from "viem";

/**
 * Chainlink's aggregators. Addresses, not a registry lookup: these two are the whole requirement,
 * and a resolver would be more calls to learn what a comment can say.
 */
/** On Ethereum mainnet. ~1h heartbeat. */
export const ETH_USD_FEED: Address = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
/** On **Arbitrum One** — see the header for why not Ethereum's. */
export const SOL_USD_FEED: Address = "0x24ceA4b8ce57cdA5058b924B9B9987992450590c";

/** The three functions of `AggregatorV3Interface` this needs, rather than the whole interface. */
const aggregatorAbi = [
    {
        type: "function",
        name: "latestRoundData",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { name: "roundId", type: "uint80" },
            { name: "answer", type: "int256" },
            { name: "startedAt", type: "uint256" },
            { name: "updatedAt", type: "uint256" },
            { name: "answeredInRound", type: "uint80" },
        ],
    },
    {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint8" }],
    },
] as const;

/** USD is carried at 6 decimals everywhere in this directory, so no total is ever a float. */
export const USD_DECIMALS = 6;

export interface MainnetPrices {
    /** What one unit of EVM gas costs right now, in wei. */
    gasPriceWei: bigint;
    /** Micro-dollars: 2677.738300 USD is `2_677_738_300n`. */
    ethUsdMicros: bigint;
    solUsdMicros: bigint;
    /**
     * The **older** of the two feeds' `updatedAt`, in unix seconds.
     *
     * The older one, because a headline mixing a fresh ETH price with a day-old SOL price is exactly
     * as old as its worst input, and reporting the fresher one would be choosing the flattering
     * number.
     */
    asOfSeconds: number;
}

export async function readMainnetPrices(clients: {
    /** Ethereum mainnet: the base fee, the tip, and ETH/USD. */
    ethereum: PublicClient;
    /** Arbitrum One: SOL/USD. */
    arbitrum: PublicClient;
}): Promise<MainnetPrices> {
    const client = clients.ethereum;
    const [block, tip, eth, sol] = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.estimateMaxPriorityFeePerGas(),
        readFeed(client, ETH_USD_FEED, "ETH/USD"),
        readFeed(clients.arbitrum, SOL_USD_FEED, "SOL/USD"),
    ]);

    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
        // Every mainnet block since EIP-1559 has a base fee, so its absence means the RPC is another chain.
        throw new Error(
            "Block has no base fee. Point VITE_MAINNET_RPC_URL at Ethereum mainnet.",
        );
    }

    return {
        // **Base fee plus the tip, never viem's `maxFeePerGas`.** That value is `baseFee * 1.2 + tip`
        // — a ceiling you authorise so a rising base fee cannot strand the transaction — and the
        // difference is refunded. Charging it here would overstate every figure on screen by ~20%.
        gasPriceWei: block.baseFeePerGas + tip,
        ethUsdMicros: eth.usdMicros,
        solUsdMicros: sol.usdMicros,
        asOfSeconds: Math.min(eth.updatedAt, sol.updatedAt),
    };
}

async function readFeed(
    client: PublicClient,
    address: Address,
    label: string,
): Promise<{ usdMicros: bigint; updatedAt: number }> {
    // `decimals()` is read rather than assumed. Both feeds answer 8 today, and an aggregator that
    // ever answered something else would otherwise be wrong by a power of ten — silently, because a
    // price is exactly the kind of number nobody can eyeball for a factor of 100.
    const [round, decimals] = await Promise.all([
        client.readContract({ address, abi: aggregatorAbi, functionName: "latestRoundData" }),
        client.readContract({ address, abi: aggregatorAbi, functionName: "decimals" }),
    ]);

    const [, answer, , updatedAt] = round;
    // `answer` is a signed int256 and a feed reports a fault as zero or negative. Refused rather
    // than clamped: a zero price renders every fee as free, which is the one wrong answer that looks
    // like good news.
    if (answer <= 0n) {
        throw new Error(`The ${label} feed answered ${answer}, which is not a usable price.`);
    }

    return { usdMicros: rescale(answer, decimals, USD_DECIMALS), updatedAt: Number(updatedAt) };
}

/** Between two fixed-point scales, in bigint. Truncates, which at micro-dollars is sub-cent noise. */
export function rescale(value: bigint, from: number, to: number): bigint {
    if (to >= from) return value * 10n ** BigInt(to - from);
    return value / 10n ** BigInt(from - to);
}
