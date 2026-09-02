#!/usr/bin/env node
// Weekly ClawSweeper digest for Slack, built from generated state.
//
// Three lists, each with an owner to act on it:
//   1. product/behavior decisions still pending (with the likely owner)
//   2. confident P0-P1 findings on open PRs that nobody has answered yet
//   3. proposed closes (observe-only mode: nothing closes by itself)
//
//   node scripts/slack-digest.mjs --state-dir clawsweeper-state [--dry-run]
//
// Environment:
//   SLACK_BOT_TOKEN + SLACK_CHANNEL, or SLACK_WEBHOOK_URL   destination
//   GH_TOKEN            optional; enables the "sin respuesta" check on findings
//   SLACK_MENTION_MAP   optional JSON {"githubLogin":"U0…"} for @mentions
//   DIGEST_IGNORED_LOGINS optional comma list of automation accounts (default HamelynDev)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_LISTED = 10;
const MIN_FINDING_CONFIDENCE = 0.6;
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, none: 4 };
const GITHUB_API = "https://api.github.com";

function fail(message) {
  process.stderr.write(`[slack-digest] ${message}\n`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const entries = match[1]
    .split("\n")
    .map((line) => line.match(/^([A-Za-z0-9_]+):\s*(.*)$/))
    .filter(Boolean)
    .map(([, key, raw]) => {
      const value = raw.trim().replace(/^"(.*)"$/, "$1");
      return [key, value];
    });
  return Object.fromEntries(entries);
}

function sectionValue(markdown, heading) {
  const match = markdown.match(
    new RegExp(
      `(?:^|\\n)## ${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n\\n([\\s\\S]*?)(?=\\n## |$)`,
    ),
  );
  return match ? match[1] : "";
}

// Mirrors parseReviewFindingHeading in src/clawsweeper.ts:
//   - **[P1] title:** `path:12-14`
//     - confidence: 0.9
export function parseFindings(markdown) {
  const section = sectionValue(markdown, "Review Findings");
  const findings = [];
  let current = null;
  for (const line of section.split("\n")) {
    const heading = line.match(/^- \*\*\[P([0-3])\] (.+?):\*\*\s*`([^`]+)`/);
    if (heading) {
      current = {
        priority: Number(heading[1]),
        title: heading[2],
        location: heading[3],
        confidence: 0,
      };
      findings.push(current);
      continue;
    }
    if (!current) continue;
    const confidence = line.match(/^\s+- confidence: ([0-9.]+)$/);
    if (confidence) current.confidence = Math.min(1, Math.max(0, Number(confidence[1])));
  }
  return findings;
}

function parseMaintainerDecision(report) {
  const raw = report.maintainer_decision;
  if (!raw || raw === "none" || raw === "unknown") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.required ? parsed : null;
  } catch {
    return null;
  }
}

function readReports(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      try {
        const markdown = readFileSync(join(dir, name), "utf8");
        return { ...parseFrontmatter(markdown), markdown };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isBotLogin(login, ignoredLogins) {
  const value = String(login || "").trim();
  if (!value) return false;
  if (/\[bot\]$/i.test(value) || value.startsWith("app/")) return true;
  return ignoredLogins.has(value.toLowerCase());
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${url}`);
  return response.json();
}

// True when a person (not a bot, not an ignored automation login) commented
// after the review. Without a token the check is skipped and reported as such.
async function humanRepliedAfter(report, token, ignoredLogins) {
  if (!token) return null;
  const since = report.reviewed_at;
  if (!since || !report.repository || !report.number) return null;
  try {
    const comments = await githubJson(
      `${GITHUB_API}/repos/${report.repository}/issues/${report.number}/comments?since=${encodeURIComponent(since)}&per_page=100`,
      token,
    );
    return comments.some(
      (comment) =>
        Date.parse(comment.created_at || "") > Date.parse(since) &&
        comment.user?.type !== "Bot" &&
        !isBotLogin(comment.user?.login, ignoredLogins),
    );
  } catch (error) {
    process.stderr.write(
      `[slack-digest] comment check failed for #${report.number}: ${error.message}\n`,
    );
    return null;
  }
}

function priorityRank(value) {
  return PRIORITY_ORDER[value] ?? PRIORITY_ORDER.none;
}

function itemLink(report) {
  const kind = report.type === "pull_request" ? "PR" : "issue";
  return `<${report.url}|${kind} #${report.number}>`;
}

function shortTitle(report, max = 70) {
  const title = String(report.title || "")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

function clip(text, max) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function mentionFor(login, mentionMap) {
  const value = String(login || "").trim();
  if (!value) return "sin dueño claro";
  const id = mentionMap[value] ?? mentionMap[value.toLowerCase()];
  return id ? `<@${id}>` : `@${value}`;
}

function overflowLine(total) {
  return total > MAX_LISTED ? [`…y ${total - MAX_LISTED} más en el state repo.`] : [];
}

export function buildDigest({ items, humanReplies, mentionMap, days }) {
  const decisions = items
    .map((report) => ({ report, decision: parseMaintainerDecision(report) }))
    .filter(({ report, decision }) => decision || report.requires_product_decision === "true")
    .sort(
      (left, right) =>
        priorityRank(left.report.triage_priority) - priorityRank(right.report.triage_priority) ||
        String(right.report.reviewed_at).localeCompare(String(left.report.reviewed_at)),
    );

  const findings = items
    .filter((report) => report.type === "pull_request")
    .map((report) => ({
      report,
      findings: parseFindings(report.markdown).filter(
        (finding) => finding.priority <= 1 && finding.confidence >= MIN_FINDING_CONFIDENCE,
      ),
    }))
    .filter(
      ({ report, findings: list }) =>
        list.length > 0 && humanReplies.get(Number(report.number)) !== true,
    )
    .sort(
      (left, right) =>
        Math.min(...left.findings.map((f) => f.priority)) -
          Math.min(...right.findings.map((f) => f.priority)) ||
        String(left.report.reviewed_at).localeCompare(String(right.report.reviewed_at)),
    );

  const proposals = items.filter(
    (report) => report.decision && report.decision !== "keep_open" && report.decision !== "unknown",
  );

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🧹 ClawSweeper — resumen semanal" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${items.length} issues/PRs abiertos con revisión · ${decisions.length} decisiones pendientes · ${findings.length} PRs con hallazgos P0-P1 sin respuesta · ${proposals.length} cierres propuestos (últimos ${days} días de estado).`,
      },
    },
  ];

  const decisionLines = decisions.slice(0, MAX_LISTED).map(({ report, decision }) => {
    const owner = mentionFor(decision?.likelyOwner?.person, mentionMap);
    const question = clip(decision?.question || "Decisión de producto pendiente", 160);
    const recommended = decision?.options?.find((option) => option.recommended);
    const suffix = recommended ? ` Recomendación: _${clip(recommended.title, 60)}_.` : "";
    return `• ${itemLink(report)} ${shortTitle(report)} — ${question} → ${owner}.${suffix}`;
  });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*1. Decisiones de producto pendientes*",
        ...(decisionLines.length ? decisionLines : ["Ninguna. 🎉"]),
        ...overflowLine(decisions.length),
      ].join("\n"),
    },
  });

  const findingLines = findings.slice(0, MAX_LISTED).map(({ report, findings: list }) => {
    const top = list.sort((a, b) => a.priority - b.priority || b.confidence - a.confidence)[0];
    const checked = humanReplies.has(Number(report.number)) ? "" : " _(respuesta sin comprobar)_";
    return `• ${itemLink(report)} ${shortTitle(report)} — [P${top.priority}] ${clip(top.title, 120)} (\`${top.location}\`)${checked}`;
  });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*2. Hallazgos P0-P1 sin respuesta*",
        ...(findingLines.length ? findingLines : ["Ninguno. 🎉"]),
        ...overflowLine(findings.length),
      ].join("\n"),
    },
  });

  const proposalLines = proposals.slice(0, MAX_LISTED).map((report) => {
    const reason =
      report.close_reason && report.close_reason !== "none" ? report.close_reason : report.decision;
    return `• ${itemLink(report)} ${shortTitle(report)} — \`${reason}\` (${report.confidence ?? "?"})`;
  });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*3. Cierres propuestos* (nada se cierra solo; cierra una persona)",
        ...(proposalLines.length ? proposalLines : ["Ninguno."]),
        ...overflowLine(proposals.length),
      ].join("\n"),
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Comandos en issues/PRs: `@clawsweeper review | explain | stop`. Este resumen llega los lunes.",
      },
    ],
  });
  return {
    blocks,
    counts: { decisions: decisions.length, findings: findings.length, proposals: proposals.length },
  };
}

async function postToSlack(blocks) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks }),
    });
    if (!response.ok) fail(`Slack webhook returned ${response.status}: ${await response.text()}`);
    return;
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  if (!botToken || !channel) {
    fail("set SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN and SLACK_CHANNEL");
  }
  const post = async () => {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, blocks, text: "ClawSweeper — resumen semanal" }),
    });
    return response.json();
  };
  let payload = await post();
  if (!payload.ok && payload.error === "not_in_channel") {
    const join = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel }),
    });
    const joined = await join.json();
    if (!joined.ok) {
      fail(
        `conversations.join failed: ${joined.error} (for a private channel, invite the ClawSweeper app first)`,
      );
    }
    payload = await post();
  }
  if (!payload.ok) fail(`chat.postMessage failed: ${payload.error ?? "unknown"}`);
}

function parseMentionMap() {
  const raw = process.env.SLACK_MENTION_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    process.stderr.write("[slack-digest] SLACK_MENTION_MAP is not valid JSON; mentions disabled\n");
    return {};
  }
}

async function main() {
  const stateDir = argValue("--state-dir");
  if (!stateDir) fail("usage: --state-dir <checkout of the state repo> [--dry-run]");
  const dryRun = process.argv.includes("--dry-run");
  const days = Number(argValue("--days") ?? 7);
  const targetRepo = argValue("--target-repo");
  const ignoredLogins = new Set(
    (process.env.DIGEST_IGNORED_LOGINS ?? "HamelynDev")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
  const mentionMap = parseMentionMap();

  const recordsDir = join(stateDir, "records");
  const slugs = existsSync(recordsDir)
    ? readdirSync(recordsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const items = slugs
    .flatMap((slug) => readReports(join(recordsDir, slug, "items")))
    .filter((report) => !targetRepo || report.repository === targetRepo.toLowerCase());

  const humanReplies = new Map();
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  for (const report of items) {
    if (report.type !== "pull_request") continue;
    const hasTopFinding = parseFindings(report.markdown).some(
      (finding) => finding.priority <= 1 && finding.confidence >= MIN_FINDING_CONFIDENCE,
    );
    if (!hasTopFinding) continue;
    const replied = await humanRepliedAfter(report, token, ignoredLogins);
    if (replied !== null) humanReplies.set(Number(report.number), replied);
  }

  const { blocks, counts } = buildDigest({ items, humanReplies, mentionMap, days });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(blocks, null, 2)}\n`);
    process.stderr.write(`[slack-digest] dry-run ${JSON.stringify(counts)}\n`);
    return;
  }
  await postToSlack(blocks);
  process.stderr.write(`[slack-digest] posted ${JSON.stringify(counts)}\n`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) await main();
