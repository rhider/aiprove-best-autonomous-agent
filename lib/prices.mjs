// Price data for the prediction workers. Keyless public sources only:
// CoinGecko (crypto) and Yahoo Finance chart API (stocks). Both are fetched
// with the same retry/timeout policy as the board itself.
import { fetchJson } from "./http.mjs";

/** CoinGecko 14-day daily closes for a coin id (e.g. "bitcoin"). */
export async function getCoinCloses(coinId, days = 14) {
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
    {},
    2
  );
  if (!Array.isArray(data.prices) || data.prices.length < 3) {
    throw new Error(`CoinGecko returned no usable prices for ${coinId}`);
  }
  return data.prices.map(([t, price]) => ({ t, close: price }));
}

/** Yahoo Finance daily closes for a stock symbol (e.g. "NVDA"). */
export async function getStockCloses(symbol, range = "10d") {
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`,
    { headers: { "user-agent": "Mozilla/5.0" } },
    2
  );
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes) || closes.filter((c) => c != null).length < 3) {
    throw new Error(`Yahoo returned no usable closes for ${symbol}`);
  }
  const stamps = result.timestamp || [];
  return closes
    .map((close, i) => ({ t: (stamps[i] || 0) * 1000, close }))
    .filter((p) => p.close != null);
}

/** Log returns between consecutive closes. */
export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(Math.log(closes[i].close / closes[i - 1].close));
  }
  return out;
}

/** Sample standard deviation of an array of numbers. */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Wilder RSI(14) from daily closes; null when not enough data. */
export function rsi14(closes) {
  if (closes.length < 15) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i].close - closes[i - 1].close);
  }
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < 14; i++) {
    if (changes[i] >= 0) gain += changes[i];
    else loss -= changes[i];
  }
  let avgGain = gain / 14;
  let avgLoss = loss / 14;
  for (let i = 14; i < changes.length; i++) {
    const c = changes[i];
    avgGain = (avgGain * 13 + Math.max(c, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-c, 0)) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Summary stats for a close series: last, 7d/5d log returns, daily vol, RSI. */
export function summarize(closes) {
  const last = closes[closes.length - 1].close;
  const rets = logReturns(closes);
  const ret7d = rets.slice(-7).reduce((a, b) => a + b, 0);
  const ret5d = rets.slice(-5).reduce((a, b) => a + b, 0);
  return {
    last,
    closes: closes.length,
    ret7d,
    ret5d,
    meanDaily: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    dailyVol: stdev(rets),
    rsi14: rsi14(closes),
  };
}
