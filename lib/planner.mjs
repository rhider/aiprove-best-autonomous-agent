// Planner: turns the open-bounty list into an execution plan.
//
// The agent can only complete a bounty on its own when it has a worker for
// that bounty shape. Prediction bounties (forecast yes/no, single number)
// are completable with market data. Repo / link / creative / referral
// bounties need a human-side artefact (GitHub repo, X post, image, video),
// so they are recorded as skipped with a reason instead of attempted.
//
// Gating: a brief that says "Entry requires holding $PROVE" (or
// "submissions open at launch") is unenterable in open beta — $PROVE does
// not exist yet, and the API enforces the gate. The planner filters those
// out before any enter call, and the executor treats a hold-gate error as
// a skip, never as a retry.
import { WORKERS } from "./workers.mjs";

const HOLD_GATE_RE = /hold-to-play|hold or stake|requires holding \$PROVE|submissions open at launch/i;

/** Is this bounty hold-to-play gated (unenterable until $PROVE launches)? */
export function isGated(bounty) {
  const brief = bounty.brief || "";
  return HOLD_GATE_RE.test(brief);
}

/** Rough USD value for ranking. bounty.usd wins; stock units use a live-ish
 *  reference only when the API gives no usd field (kept conservative). */
export function usdValue(bounty) {
  if (typeof bounty.usd === "number") return bounty.usd;
  return 0; // PROVE / unknown-denominated prizes: value unknown, rank by feasibility
}

/** Urgency multiplier: bounties closing within 24h get a boost. */
export function urgency(bounty, now = Date.now()) {
  if (!bounty.endsAt) return 1;
  const hoursLeft = (bounty.endsAt - now) / 3_600_000;
  if (hoursLeft <= 0) return 0; // already closed
  if (hoursLeft <= 24) return 1.5;
  if (hoursLeft <= 72) return 1.2;
  return 1;
}

/**
 * Build the plan.
 * @param {Array} details - full bounty detail objects (GET /api/bounties/:slug)
 * @param {Set<string>} alreadySubmitted - slugs this agent already submitted
 * @param {number} maxBounties - execution budget for this run
 * @returns {{ selected: Array, skipped: Array }}
 */
export function plan(details, alreadySubmitted, maxBounties) {
  const selected = [];
  const skipped = [];
  const now = Date.now();

  for (const b of details) {
    const bounty = b.bounty || b;
    const slug = bounty.slug;
    if (!slug) continue;

    if (alreadySubmitted.has(slug)) {
      skipped.push({ slug, reason: "already-submitted" });
      continue;
    }
    if (bounty.status && bounty.status !== "open") {
      skipped.push({ slug, reason: `status=${bounty.status}` });
      continue;
    }
    if (bounty.endsAt && bounty.endsAt <= now + 3_600_000) {
      skipped.push({ slug, reason: "closes within 1h" });
      continue;
    }
    if (isGated(bounty)) {
      skipped.push({ slug, reason: "hold-to-play gated (100,000 $PROVE, token not launched)" });
      continue;
    }
    const worker = WORKERS.find((w) => w.matches(bounty));
    if (!worker) {
      skipped.push({ slug, reason: `no autonomous worker (submitKind=${b.submitKind || "?"}, needs human artefact)` });
      continue;
    }
    const score = (1 + Math.log10(1 + usdValue(bounty))) * urgency(bounty, now);
    selected.push({ bounty, worker, score });
  }

  selected.sort((a, b) => b.score - a.score);
  const picked = selected.slice(0, maxBounties);
  for (const extra of selected.slice(maxBounties)) {
    skipped.push({ slug: extra.bounty.slug, reason: "over run budget" });
  }
  return { selected: picked, skipped };
}
