# aiprove-autonomous-agent

Fully autonomous agent for the AIProve bounty board (aiprove.fun) — no human
in the loop. Built for the **best-autonomous-agent** bounty (0.3 GLD, closes
15 Nov 2026 20:49 WIB).

## What it does, end to end

1. **Reads `skill.md`** from the board and *parses its endpoint table* — the
   loop is driven by the API surface it finds there, not by a hard-coded
   sequence.
2. **Authenticates with its own keypair** (generated + saved to `.env` on
   first run; EIP-191 challenge → sign → session token). Token lives only in
   memory and is never logged.
3. **Lists open bounties**, fetches each one's detail, and checks what this
   agent already submitted (idempotent — it never re-submits).
4. **Plans**: scores bounties by value × urgency × feasibility, and skips
   what it cannot do autonomously — with a reason recorded for each skip:
   - hold-to-play gated bounties (`Entry requires holding $PROVE`) — the API
     enforces the gate and $PROVE has not launched, so these are unenterable
     in open beta;
   - repo / link / creative / referral bounties, which need a human-side
     artefact (GitHub repo, X post, image, video).
5. **Executes**: enter → run the prediction worker → submit → verify the
   submission on the server. A failure on one bounty never kills the run;
   the agent logs it and moves to the next.
6. **Reports**: a JSON run report + a secrets-stripped transcript in `runs/`
   (the transcript is what gets submitted as provenance for repo bounties;
   the server stores only its SHA-256 hash).

## Prediction workers (honest, documented models)

| Worker | Bounty | Model |
|---|---|---|
| `btc-7d-direction` | forecast-btc-7d | P(up) = 0.5 + 2.0·ret7d − 0.25·(RSI−50)/50, clamped [0.20, 0.80]. Momentum pushes P down after a selloff; oversold RSI pulls it back. |
| `nvda-3d-close` | forecast-nvda-3d | Oversold-bounce median: last close + small mean-reversion tilt when RSI(14) < 30 (+0.5%/session). No momentum extrapolation — the earnings move is symmetric, so the median is the honest point forecast. |
| `crypto-yes-no` | any "Will \<coin\> close higher …?" yes/no brief | Same momentum–RSI model on the named coin (CoinGecko). |
| `numeric-close` | any "single number … close" brief | NVDA median model when the brief names NVDA. |

Price data comes from keyless public sources only: CoinGecko (crypto) and
Yahoo Finance chart API (stocks). A confident wrong call costs more than a
hedged one under Brier / absolute-error scoring, so every worker returns a
probability or a median — never a coin flip.

## Run it

```bash
npm install
node agent.mjs            # full autonomous run (default: up to 3 bounties)
DRY_RUN=1 node agent.mjs  # plan + compute predictions, do not enter/submit
MAX_BOUNTIES=1 node agent.mjs
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_PRIVATE_KEY` | (generated) | 0x-prefixed secp256k1 key. Saved to `.env` (mode 600) on first run if missing. Never commit it. |
| `API_BASE_URL` | `https://aiprove.fun` | Point at a staging arena to test against a sandbox. |
| `AGENT_HANDLE` | `auto-<addr8>` | Handle shown on entries. |
| `MAX_BOUNTIES` | `3` | Bounties attempted per run (budget guard). |
| `DRY_RUN` | `0` | `1` = plan only, no enter/submit. |
| `RUNS_DIR` | `./runs` | Where reports and transcripts go. |

## Layout

```
agent.mjs            entry point + orchestration (the loop)
lib/http.mjs         fetch with retries/timeouts, secret-safe errors
lib/client.mjs       AIProve REST client (auth, list, enter, submit, me)
lib/planner.mjs      scoring, ranking, gating detection, skip reasons
lib/workers.mjs      prediction workers (BTC 7d, NVDA 3d, generic)
lib/prices.mjs       CoinGecko + Yahoo price fetchers, RSI, stats
lib/report.mjs       run report + secrets-stripped transcript
runs/                per-run report.json + transcript.md (git-ignored)
```

## How this differs from the sample agent

The sample agent (`sample-agent-skillmd`) proves one clean loop: read
skill.md → authenticate → list → enter **one** bounty. This agent adds the
parts that make it *autonomous*: it parses skill.md instead of string-matching
it, generates its own keypair, plans across **all** open bounties, detects and
skips gated/unworkable bounties with reasons, actually **completes**
prediction bounties with live market data (not just entering them), retries
and survives per-bounty failures, verifies every submission on the server,
and writes a full report + transcript. Entering is the easy part — finishing
bounties with no human in the loop is the point.
