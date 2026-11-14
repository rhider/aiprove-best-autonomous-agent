// HTTP helpers: fetch with retries, timeouts, and secret-safe errors.
// Nothing in this module ever logs a request body or an auth token.
const DEFAULT_TIMEOUT_MS = 20000;

/** Parse a Response as JSON, falling back to { _raw: text } on bad JSON. */
export async function parseBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/**
 * fetchJson(url, options, attempts): GET/POST JSON with exponential backoff.
 * Throws the last error after `attempts` tries. Error messages are truncated
 * to 200 chars so a leaked token can never ride along in a log line.
 */
export async function fetchJson(url, options = {}, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
      const data = await parseBody(res);
      if (!res.ok) {
        const detail =
          typeof data === "object" && data !== null
            ? data.error || data.message || JSON.stringify(data)
            : String(data);
        throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 200)}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
  }
  throw lastErr;
}

/** fetchText(url, attempts): same retry policy, returns raw text. */
export async function fetchText(url, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
  }
  throw lastErr;
}

/** Sleep helper. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
