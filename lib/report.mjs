// Run report + transcript. Every step the agent takes is recorded with a
// timestamp; secrets are stripped before anything is written to disk.
// The transcript is what gets submitted as provenance for repo bounties:
// the server stores only its SHA-256 hash, never the raw text.
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const SECRET_PATTERNS = [
  /0x[0-9a-fA-F]{64}/g, // private keys
  /Bearer [A-Za-z0-9._\-~+/=]+/g, // session tokens
  /"token"\s*:\s*"[^"]+"/g, // token fields in JSON
  /"signature"\s*:\s*"0x[0-9a-fA-F]+"/g, // signatures
];

export function stripSecrets(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class RunReport {
  constructor({ api, agent, handle }) {
    this.startedAt = new Date().toISOString();
    this.api = api;
    this.agent = agent;
    this.handle = handle;
    this.steps = [];
    this.results = [];
    this.skipped = [];
  }

  step(name, msg) {
    const line = `[${new Date().toISOString()}] ${name} ${msg}`;
    this.steps.push(stripSecrets(line));
    console.log(line);
  }

  result(entry) {
    this.results.push(entry);
  }

  skip(entry) {
    this.skipped.push(entry);
  }

  summary() {
    const done = this.results.filter((r) => r.status === "submitted").length;
    const failed = this.results.filter((r) => r.status === "failed").length;
    return {
      agent: this.agent,
      handle: this.handle,
      api: this.api,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      completed: done,
      failed,
      skipped: this.skipped.length,
      results: this.results,
      skippedList: this.skipped,
    };
  }

  transcriptText() {
    const s = this.summary();
    return [
      `# Autonomous run transcript — ${s.startedAt}`,
      ``,
      `Agent: ${s.agent} (handle ${s.handle})`,
      `API: ${s.api}`,
      `Completed: ${s.completed} bounty(ies), failed: ${s.failed}, skipped: ${s.skipped}`,
      ``,
      `## Steps`,
      ...this.steps,
      ``,
      `## Results`,
      ...this.results.map((r) => `- ${r.slug}: ${r.status} ${r.detail || ""}`),
      ``,
      `## Skipped`,
      ...this.skipped.map((x) => `- ${x.slug}: ${x.reason}`),
      ``,
      `Transcript SHA-256 (server stores only this hash): ${sha256(this.steps.join("\n"))}`,
      ``,
    ].join("\n");
  }

  /** Write report.json + transcript.md into runsDir; returns the paths. */
  async write(runsDir) {
    await mkdir(runsDir, { recursive: true });
    const stamp = this.startedAt.replace(/[:.]/g, "-");
    const reportPath = join(runsDir, `${stamp}-report.json`);
    const transcriptPath = join(runsDir, `${stamp}-transcript.md`);
    await writeFile(reportPath, JSON.stringify(this.summary(), null, 2), "utf8");
    await writeFile(transcriptPath, this.transcriptText(), "utf8");
    return { reportPath, transcriptPath };
  }
}
