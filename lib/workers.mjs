// Prediction workers. Each worker turns a bounty brief + live market data
// into a submission payload, with its reasoning attached for the run report.
//
// The models are deliberately simple and documented: they are honest
// point forecasts / calibrated probabilities, not black boxes. A confident
// wrong call costs more than a hedged one (Brier / absolute-error scoring),
// so every worker returns a probability or median, never a coin flip.
//
// Prediction strings follow the board's own frontend format:
//   - yes/no + probability: "yes 0.62" / "no 0.62"
//   - single number: "164.50"
import { getCoinCloses, getStockCloses, summarize } from "./prices.mjs";

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * BTC 7-day direction (forecast-btc-7d and any "Will BTC close higher seven
 * days from now?" brief). Baseline: the most recent daily close.
 * Model: P(up) = 0.5 + 2.0 * ret7d - 0.25 * (rsi14 - 50) / 50, clamped
 * to [0.20, 0.80]. Momentum pushes P down after a selloff; an oversold RSI
 * pulls it back up. With ret7d -13% and RSI ~22 this gives P(up) ~0.38.
 */
async function btc7d(bounty) {
  const closes = await getCoinCloses("bitcoin", 14);
  const s = summarize(closes);
  const rsi = s.rsi14 ?? 50;
  const pUp = clamp(0.5 + 2.0 * s.ret7d - 0.25 * ((rsi - 50) / 50), 0.2, 0.8);
  const prediction = pUp >= 0.5 ? `yes ${pUp.toFixed(2)}` : `no ${(1 - pUp).toFixed(2)}`;
  return {
    prediction,
    reasoning:
      `BTC last close $${s.last.toFixed(0)}; 7d log return ${(s.ret7d * 100).toFixed(1)}%; ` +
      `RSI(14) ${rsi.toFixed(1)}; P(up in 7d) = ${pUp.toFixed(2)} (momentum - RSI model).`,
  };
}

/**
 * NVDA 3-day close (forecast-nvda-3d and any "single number ... NVDA close
 * three days out" brief). Model: oversold-bounce median.
 * The 3 sessions ahead straddle an earnings report whose implied move is
 * roughly symmetric (±7-9%), so the move dominates the error and no
 * directional bet is justified — the conditional median sits near the last
 * close, plus a small mean-reversion tilt when RSI is oversold (buyers
 * defended the lows after the selloff). Momentum extrapolation would be a
 * direction call, not a median, so it is deliberately NOT used here.
 *   bounce/session = +0.5% if RSI(14) < 30, +0.2% if RSI < 45, else 0.
 */
async function nvda3d(bounty) {
  const closes = await getStockCloses("NVDA", "1mo");
  const s = summarize(closes);
  const rsi = s.rsi14 ?? 50;
  const bounce = rsi < 30 ? 0.005 : rsi < 45 ? 0.002 : 0;
  const forecast = s.last * Math.exp(bounce * 3);
  const prediction = forecast.toFixed(2);
  return {
    prediction,
    reasoning:
      `NVDA last close $${s.last.toFixed(2)}; RSI(14) ${rsi.toFixed(1)}; ` +
      `oversold-bounce tilt +${(bounce * 100).toFixed(1)}%/session x 3 sessions; ` +
      `3-session median $${prediction} (earnings move symmetric, no direction bet).`,
  };
}

/**
 * Generic crypto yes/no worker: any brief that asks "Will <COIN> close
 * higher ...?" with a yes/no + probability. Reuses the BTC model on the
 * named coin's CoinGecko id (bitcoin / ethereum).
 */
async function genericCryptoYesNo(bounty) {
  const brief = (bounty.brief || "").toLowerCase();
  const coinId = brief.includes("eth") ? "ethereum" : "bitcoin";
  const closes = await getCoinCloses(coinId, 14);
  const s = summarize(closes);
  const rsi = s.rsi14 ?? 50;
  const pUp = clamp(0.5 + 2.0 * s.ret7d - 0.25 * ((rsi - 50) / 50), 0.2, 0.8);
  const prediction = pUp >= 0.5 ? `yes ${pUp.toFixed(2)}` : `no ${(1 - pUp).toFixed(2)}`;
  return {
    prediction,
    reasoning:
      `${coinId.toUpperCase()} last close $${s.last.toFixed(0)}; 7d log return ${(s.ret7d * 100).toFixed(1)}%; ` +
      `RSI(14) ${rsi.toFixed(1)}; P(up) = ${pUp.toFixed(2)} (momentum - RSI model).`,
  };
}

/**
 * Generic numeric worker: any brief asking for "a single number" for a
 * named stock close. Currently only NVDA is wired (Yahoo data verified).
 */
async function genericNumeric(bounty) {
  const brief = (bounty.brief || "").toLowerCase();
  if (brief.includes("nvda")) return nvda3d(bounty);
  return null;
}

// Worker registry. `matches` decides whether this worker can attempt the
// bounty; `run` produces { prediction, reasoning } or throws.
export const WORKERS = [
  {
    name: "btc-7d-direction",
    matches: (b) => b.slug === "forecast-btc-7d",
    run: btc7d,
  },
  {
    name: "nvda-3d-close",
    matches: (b) => b.slug === "forecast-nvda-3d",
    run: nvda3d,
  },
  {
    name: "crypto-yes-no",
    matches: (b) =>
      b.submitKind === "prediction" &&
      /will \w+ close higher/i.test(b.brief || "") &&
      /yes or no/i.test(b.brief || ""),
    run: genericCryptoYesNo,
  },
  {
    name: "numeric-close",
    matches: (b) =>
      b.submitKind === "prediction" &&
      /single number/i.test(b.brief || "") &&
      /close/i.test(b.brief || ""),
    run: genericNumeric,
  },
];
