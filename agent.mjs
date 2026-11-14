// aiprove-autonomous-agent — fully autonomous AIProve agent.
//
// One command, no human in the loop:
//   1. Read skill.md (and PARSE its endpoint table — the agent drives the
//      API surface it finds there, it does not hard-code the loop).
//   2. Authenticate with its own keypair (generated + saved to .env on
//      first run; EIP-191 challenge -> sign -> session token).
//   3. List open bounties, fetch each one's detail, check what this agent
//      already submitted (idempotency).
//   4. Plan: score bounties by value x urgency x feasibility, skip
//      hold-to-play gated bounties and shapes it has no worker for.
//   5. Execute: enter -> run the worker -> submit -> verify on the server.
//      Per-bounty failures never kill the run; the agent moves on.
//   6. Report: run report + secrets-stripped transcript on disk.
//
// Configuration (environment variables, or .env in the working directory):
//   AGENT_PRIVATE_KEY  0x-prefixed secp256k1 key; generated if missing.
//                      NEVER commit it. The session token is never logged.
//   API_BASE_URL       default https://aiprove.fun
//   AGENT_HANDLE       default "auto-<first 8 hex of address>"
//   MAX_BOUNTIES       bounties to attempt per run (default 3)
//   DRY_RUN=1          plan + compute predictions, but do not enter/submit
//   RUNS_DIR           where reports go (default ./runs)
//
// Exit code 0 = the loop ran to a report; 1 = fatal failure before planning.
import { Wallet } from "ethers";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchText } from "./lib/http.mjs";
import { AIProveClient, isHoldGateError, isAlreadyError } from "./lib/client.mjs";
import { plan } from "./lib/planner.mjs";
import { RunReport } from "./lib/report.mjs";

const API = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/$/, "");
const MAX_BOUNTIES = Number(process.env.MAX_BOUNTIES || 3);
const DRY_RUN = process.env.DRY_RUN === "1";
const RUNS_DIR = process.env.RUNS_DIR || join(process.cwd(), "runs");

/** Minimal .env parser (KEY=VALUE lines, no interpolation). */
async function loadDotEnv() {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/** Get or generate the agent keypair. Generated keys are saved to .env (0600). */
async function getWallet() {
  await loadDotEnv();
  if (process.env.AGENT_PRIVATE_KEY) {
    return new Wallet(process.env.AGENT_PRIVATE_KEY);
  }
  const wallet = Wallet.createRandom();
  const envPath = join(process.cwd(), ".env");
  await writeFile(envPath, `AGENT_PRIVATE_KEY=${wallet.privateKey}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log(`[keygen] no AGENT_PRIVATE_KEY found — generated a new keypair, saved to .env (mode 600). Address: ${wallet.address}`);
  console.log("[keygen] BACK UP .env: losing it loses this agent identity.");
  return wallet;
}

/** Parse the endpoint table out of skill.md so the loop is data-driven. */
function parseSkillEndpoints(skillText) {
  const endpoints = [];
  for (const line of skillText.split("\n")) {
    const m = line.match(/^\|\s*(GET|POST)\s*\|\s*`([^`]+)`\s*\|/);
    if (m) endpoints.push(`${m[1]} ${m[2]}`);
  }
  return endpoints;
}

async function main() {
  const wallet = await getWallet();
  const address = wallet.address;
  const handle = process.env.AGENT_HANDLE || `auto-${address.slice(2, 10)}`;
  const report = new RunReport({ api: API, agent: address, handle });
  const client = new AIProveClient(API);

  // 1. Read skill.md and parse its endpoint table.
  report.step("step1", `reading skill.md from ${API}/skill.md ...`);
  let skillText;
  try {
    skillText = await fetchText(`${API}/skill.md`);
  } catch (e) {
    report.step("step1", `FAILED to read skill.md: ${e.message}`);
    await report.write(RUNS_DIR);
    process.exit(1);
  }
  const endpoints = parseSkillEndpoints(skillText);
  const required = ["/api/auth/challenge", "/api/bounties", "/api/bounties/:slug/submit"];
  const missing = required.filter((r) => !endpoints.some((e) => e.includes(r)));
  if (!skillText.includes("Compete on the Agent Bounty Board") || missing.length) {
    report.step("step1", `skill.md did not match expected shape (missing: ${missing.join(", ")})`);
    await report.write(RUNS_DIR);
    process.exit(1);
  }
  report.step("step1", `skill.md OK (${skillText.length} chars, ${endpoints.length} endpoints parsed: ${endpoints.slice(0, 6).join(", ")}...)`);

  // 2. Authenticate: challenge -> sign -> verify.
  report.step("step2", `requesting auth challenge for ${address} ...`);
  let auth;
  try {
    const challenge = await client.getChallenge(address);
    const signature = await wallet.signMessage(challenge);
    auth = await client.verify(address, signature);
  } catch (e) {
    report.step("step2", `FAILED authentication: ${e.message}`);
    await report.write(RUNS_DIR);
    process.exit(1);
  }
  report.step("step2", `authenticated; session expires ${new Date(auth.expiresAt).toISOString()}`);

  // 3. List open bounties + details + my submissions (idempotency).
  report.step("step3", "listing open bounties ...");
  let summaries;
  try {
    summaries = await client.listOpenBounties();
  } catch (e) {
    report.step("step3", `FAILED listing bounties: ${e.message}`);
    await report.write(RUNS_DIR);
    process.exit(1);
  }
  report.step("step3", `${summaries.length} open bounties`);
  const details = [];
  for (const s of summaries) {
    try {
      details.push(await client.getBounty(s.slug));
    } catch (e) {
      report.step("step3", `detail fetch failed for ${s.slug}: ${e.message} (skipping)`);
    }
  }
  let alreadySubmitted = new Set();
  try {
    const mine = await client.mySubmissions();
    alreadySubmitted = new Set(mine.map((s) => s.bountySlug));
    report.step("step3", `already submitted: ${[...alreadySubmitted].join(", ") || "(none)"}`);
  } catch (e) {
    report.step("step3", `could not read my submissions (${e.message}); proceeding without idempotency check`);
  }

  // 4. Plan.
  const { selected, skipped } = plan(details, alreadySubmitted, MAX_BOUNTIES);
  for (const s of skipped) report.skip(s);
  report.step(
    "step4",
    `plan: ${selected.length} to attempt [${selected.map((x) => x.bounty.slug).join(", ")}]; ${skipped.length} skipped`
  );
  for (const s of skipped) {
    report.step("step4", `  skip ${s.slug}: ${s.reason}`);
  }

  // 5. Execute, one bounty at a time. A failure on one never kills the run.
  for (const { bounty, worker } of selected) {
    const slug = bounty.slug;
    report.step("step5", `--- ${slug} (${worker.name}) ---`);
    if (DRY_RUN) {
      try {
        const out = await worker.run(bounty);
        if (!out) {
          report.result({ slug, status: "failed", detail: "worker returned no prediction" });
        } else {
          report.result({ slug, status: "dry-run", detail: `prediction ${out.prediction} (${out.reasoning})` });
        }
      } catch (e) {
        report.result({ slug, status: "failed", detail: `worker error: ${e.message}` });
      }
      continue;
    }
    try {
      try {
        const entry = await client.enter(slug, handle);
        report.step("step5", `entered ${slug} (entry ${entry.id || entry.entryId})`);
      } catch (e) {
        if (isHoldGateError(e)) {
          report.skip({ slug, reason: "hold-to-play gated at enter time" });
          report.step("step5", `${slug}: gated (100,000 $PROVE) — skipping`);
          continue;
        }
        if (isAlreadyError(e)) {
          report.step("step5", `${slug}: already entered — continuing`);
        } else {
          throw e;
        }
      }
      const out = await worker.run(bounty);
      if (!out) throw new Error("worker returned no prediction");
      report.step("step5", `prediction for ${slug}: ${out.prediction} — ${out.reasoning}`);
      const submission = await client.submit(slug, { prediction: out.prediction, handle });
      report.step("step5", `submitted ${slug} (submission ${submission.id}, status ${submission.status})`);
      // Verify on the server: my submissions must contain this id.
      const mine = await client.mySubmissions();
      const found = mine.find((s) => s.id === submission.id);
      if (!found) throw new Error("submission not found in /api/me/submissions after submit");
      report.result({ slug, status: "submitted", detail: `submission ${submission.id}, prediction ${out.prediction}` });
    } catch (e) {
      report.result({ slug, status: "failed", detail: e.message });
      report.step("step5", `${slug} FAILED: ${e.message} — moving to next bounty`);
    }
  }

  // 6. Report.
  const { reportPath, transcriptPath } = await report.write(RUNS_DIR);
  report.step("step6", `report written: ${reportPath}`);
  report.step("step6", `transcript written: ${transcriptPath}`);
  console.log(JSON.stringify(report.summary(), null, 2));
  console.log("LOOP COMPLETE");
}

main().catch(async (e) => {
  console.error(`[loop] FATAL: ${e.message}`);
  process.exit(1);
});
