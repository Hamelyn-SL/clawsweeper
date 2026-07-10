/**
 * Codex token-usage reporter. Reads the rollout JSONL files Codex writes under
 * this run's CODEX_HOME, takes each session's final token_count event
 * (cumulative totals + account rate-limit snapshot), appends a table to the job
 * summary, and POSTs the events to the Hamelyn agents usage sink (/api/usage).
 *
 * Telemetry must never break the lane: every failure path logs and exits 0.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const codexHome = process.env.CODEX_HOME ?? "";
const source = process.env.USAGE_SOURCE || "clawsweeper";
const label = process.env.USAGE_LABEL || "";
const sinkUrl = process.env.USAGE_SINK_URL || "";
const sinkToken = process.env.USAGE_SINK_TOKEN || "";
const runId = process.env.GITHUB_RUN_ID ? `gh:${process.env.GITHUB_RUN_ID}` : undefined;

// The sink validates at most 500 events per request; batch to avoid drops.
const MAX_EVENTS_PER_POST = 500;

function listRolloutFiles(root) {
  const out = [];
  for (const dir of ["sessions", "archived_sessions"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { recursive: true })) {
      const rel = String(entry);
      if (rel.endsWith(".jsonl")) out.push(join(base, rel));
    }
  }
  return out;
}

/** Last token_count event of a rollout: cumulative usage + rate limits. */
function extractSession(path) {
  let lastUsage = null;
  let lastRateLimits = null;
  let lastTs = null;
  let model = null;
  let effort = null;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!model && line.includes('"model"')) {
      const m = line.match(/"model"\s*:\s*"([^"]{1,60})"/);
      if (m) model = m[1];
    }
    if (!effort && line.includes("reasoning_effort")) {
      const e = line.match(/"reasoning_effort"\s*:\s*"([^"]{1,20})"/);
      if (e) effort = e[1];
    }
    if (!line.includes("total_token_usage")) continue;
    try {
      const obj = JSON.parse(line);
      const info = obj?.payload?.info;
      if (info?.total_token_usage) {
        lastUsage = info.total_token_usage;
        lastTs = obj.timestamp ?? lastTs;
        lastRateLimits = obj?.payload?.rate_limits ?? lastRateLimits;
      }
    } catch {
      // tolerate partial/corrupt lines
    }
  }
  if (!lastUsage) return null;
  const file = path.split("/").pop() ?? "";
  const sessionId = file.startsWith("rollout-") ? file.slice(28, -6) : file.replace(/\.jsonl$/, "");

  // Account rate-limit snapshot rides along as metadata (the sink schema keeps
  // usage fields first-class and everything else under `meta`).
  const meta = {};
  const primary = lastRateLimits?.primary;
  const secondary = lastRateLimits?.secondary;
  if (typeof primary?.used_percent === "number") {
    meta.rateLimit5h = primary.used_percent;
  }
  if (typeof secondary?.used_percent === "number") {
    meta.rateLimitWeek = secondary.used_percent;
  }
  if (typeof lastRateLimits?.plan_type === "string") {
    meta.plan = lastRateLimits.plan_type;
  }

  return {
    source,
    provider: "codex",
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    inputTokens: lastUsage.input_tokens ?? 0,
    outputTokens: lastUsage.output_tokens ?? 0,
    cachedInputTokens: lastUsage.cached_input_tokens ?? 0,
    ...(lastUsage.reasoning_output_tokens !== undefined
      ? { reasoningTokens: lastUsage.reasoning_output_tokens }
      : {}),
    totalTokens: lastUsage.total_tokens ?? 0,
    requests: 1,
    sessionId,
    ...(label ? { label } : {}),
    ...(runId ? { ref: runId } : {}),
    eventTs: lastTs ?? new Date().toISOString(),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

function writeSummary(events) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : String(n));
  let md = `### Codex token usage (${source}${label ? ` · ${label}` : ""})\n\n`;
  if (events.length === 0) {
    md += "_No Codex sessions found in this run's CODEX_HOME._\n";
  } else {
    md +=
      "| session | model | input | cached | output | burn | 5h window | weekly |\n" +
      "|---|---|---:|---:|---:|---:|---:|---:|\n";
    let burnTotal = 0;
    for (const e of events) {
      const burn = Math.max(0, e.inputTokens - e.cachedInputTokens) + e.outputTokens;
      burnTotal += burn;
      const rl5 = e.meta?.rateLimit5h ?? "?";
      const rlw = e.meta?.rateLimitWeek ?? "?";
      md += `| ${e.sessionId.slice(0, 8)}… | ${e.model ?? "?"} | ${fmt(e.inputTokens)} | ${fmt(e.cachedInputTokens)} | ${fmt(e.outputTokens)} | **${fmt(burn)}** | ${rl5}% | ${rlw}% |\n`;
    }
    md += `\n**Run burn (non-cached input + output): ${fmt(burnTotal)} tokens**\n`;
  }
  appendFileSync(summaryPath, md + "\n");
}

async function postBatch(batch) {
  const res = await fetch(sinkUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sinkToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ events: batch }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.log(`::warning::agents usage sink responded ${res.status}`);
  } else {
    console.log(`reported ${batch.length} session(s) to agents usage sink`);
  }
}

async function postToSink(events) {
  if (!sinkUrl || !sinkToken || events.length === 0) {
    if (!sinkToken) console.log("sink token not configured; summary only");
    return;
  }
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_POST) {
    await postBatch(events.slice(i, i + MAX_EVENTS_PER_POST));
  }
}

try {
  if (!codexHome || !existsSync(codexHome)) {
    console.log(`CODEX_HOME not found (${codexHome || "unset"}); nothing to report`);
    process.exit(0);
  }
  const events = listRolloutFiles(codexHome)
    .map((f) => {
      try {
        return extractSession(f);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  writeSummary(events);
  await postToSink(events);
} catch (error) {
  console.log(`::warning::codex usage report failed: ${error?.message ?? error}`);
}
process.exit(0);
