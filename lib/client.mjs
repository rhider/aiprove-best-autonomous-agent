// AIProve REST client. Thin wrapper over the skill.md endpoint table.
// The session token lives only in memory (this.token) and is never logged.
import { fetchJson } from "./http.mjs";

export class AIProveClient {
  constructor(apiBase) {
    this.api = apiBase.replace(/\/$/, "");
    this.token = null;
    this.address = null;
  }

  authHeaders() {
    return { Authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  /** Step 1 of auth: get a one-time challenge for an address. */
  async getChallenge(address) {
    const data = await fetchJson(`${this.api}/api/auth/challenge?address=${address}`);
    if (!data.challenge) throw new Error("no challenge returned");
    return data.challenge;
  }

  /** Step 2 of auth: exchange an EIP-191 signature for a session token. */
  async verify(address, signature) {
    const data = await fetchJson(`${this.api}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    if (!data.token) throw new Error("no session token returned");
    this.token = data.token;
    this.address = address;
    return data; // { address, token, expiresAt }
  }

  /** GET /api/bounties?status=open — returns an array of bounty summaries. */
  async listOpenBounties() {
    const data = await fetchJson(`${this.api}/api/bounties?status=open`);
    const list = Array.isArray(data) ? data : data.bounties || [];
    return list;
  }

  /** GET /api/bounties/:slug — full detail (brief, entries, submissions). */
  async getBounty(slug) {
    return fetchJson(`${this.api}/api/bounties/${slug}`);
  }

  /**
   * POST /api/bounties/:slug/enter — free in open beta.
   * Returns the entry object, or throws. A "Hold or stake 100,000 $PROVE"
   * error means the bounty is hold-to-play gated (unenterable until $PROVE
   * launches); callers should catch that and skip the bounty, not retry.
   */
  async enter(slug, handle) {
    const data = await fetchJson(`${this.api}/api/bounties/${slug}/enter`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ handle }),
    });
    if (!data.id && !data.entryId) {
      throw new Error(`unexpected enter response: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  }

  /**
   * POST /api/bounties/:slug/submit — prediction string (shape B) or
   * repo@commit+transcript (shape A). `payload` is passed through as-is.
   */
  async submit(slug, payload) {
    const data = await fetchJson(`${this.api}/api/bounties/${slug}/submit`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ ...payload, handle: payload.handle }),
    });
    if (data.error) throw new Error(String(data.error).slice(0, 200));
    if (!data.id) throw new Error(`unexpected submit response: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  }

  /** GET /api/me — board state for this agent. */
  async me() {
    return fetchJson(`${this.api}/api/me`, { headers: this.authHeaders() });
  }

  /** GET /api/me/submissions — my submissions (used for idempotency). */
  async mySubmissions() {
    const data = await fetchJson(`${this.api}/api/me/submissions`, {
      headers: this.authHeaders(),
    });
    return Array.isArray(data) ? data : data.submissions || [];
  }
}

/** True when an API error is the hold-to-play gate (not a transient failure). */
export function isHoldGateError(err) {
  return /hold or stake 100,?000 \$PROVE/i.test(String(err && err.message));
}

/** True when an API error says we are already entered/submitted. */
export function isAlreadyError(err) {
  return /already (entered|submitted)/i.test(String(err && err.message));
}
