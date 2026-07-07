#!/usr/bin/env node
// Post a compact daily ClawSweeper digest to Slack from generated state.
// Reads records/<repo-slug>/{items,closed}/*.md from a checkout of the state
// repository and posts one message per run to SLACK_WEBHOOK_URL (an incoming
// webhook, which fixes the destination channel).
//
//   node scripts/slack-digest.mjs --state-dir clawsweeper-state

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_LISTED_PROPOSALS = 10;

function fail(message) {
  process.stderr.write(`[slack-digest] ${message}\n`);
  process.exit(1);
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

function readReports(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      try {
        return parseFrontmatter(readFileSync(join(dir, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function summarizeRepo(recordsDir, slug) {
  const items = readReports(join(recordsDir, slug, "items"));
  const closed = readReports(join(recordsDir, slug, "closed"));
  if (items.length === 0 && closed.length === 0) return null;

  const proposals = items.filter(
    (r) => r.decision && r.decision !== "keep_open" && r.decision !== "unknown",
  );
  const openPrs = items.filter((r) => r.type === "pull_request" && r.decision === "keep_open");
  const openIssues = items.filter((r) => r.type !== "pull_request" && r.decision === "keep_open");
  const queueable = items.filter((r) => (r.work_candidate ?? "").startsWith("queueable"));
  const repository = items[0]?.repository ?? closed[0]?.repository ?? slug;

  return { repository, items, closed, proposals, openPrs, openIssues, queueable };
}

function proposalLine(report) {
  const kind = report.type === "pull_request" ? "PR" : "issue";
  const reason =
    report.close_reason && report.close_reason !== "none" ? report.close_reason : report.decision;
  const title = (report.title ?? "").slice(0, 90);
  return `• <${report.url}|${kind} #${report.number}> ${title} — \`${reason}\` (${report.confidence ?? "?"})`;
}

function repoBlocks(summary) {
  const lines = [
    `*${summary.repository}* — ${summary.items.length} con review (${summary.openPrs.length} PRs y ${summary.openIssues.length} issues se quedan abiertas), ${summary.closed.length} archivadas en total`,
  ];
  if (summary.queueable.length > 0) {
    lines.push(
      `🔧 ${summary.queueable.length} candidatas a fix automatizable (\`work_candidate: queueable\`)`,
    );
  }
  if (summary.proposals.length === 0) {
    lines.push("Sin propuestas de cierre pendientes.");
  } else {
    lines.push(`*${summary.proposals.length} propuestas de cierre pendientes:*`);
    lines.push(...summary.proposals.slice(0, MAX_LISTED_PROPOSALS).map(proposalLine));
    if (summary.proposals.length > MAX_LISTED_PROPOSALS) {
      lines.push(`…y ${summary.proposals.length - MAX_LISTED_PROPOSALS} más en el state repo.`);
    }
  }
  return { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } };
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
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, blocks, text: "ClawSweeper digest" }),
  });
  const payload = await response.json();
  if (!payload.ok) fail(`chat.postMessage failed: ${payload.error ?? response.status}`);
}

async function main() {
  const stateDirIndex = process.argv.indexOf("--state-dir");
  const stateDir = stateDirIndex >= 0 ? process.argv[stateDirIndex + 1] : null;
  if (!stateDir) fail("usage: --state-dir <checkout of the state repo>");

  const recordsDir = join(stateDir, "records");
  const slugs = existsSync(recordsDir)
    ? readdirSync(recordsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const summaries = slugs.map((slug) => summarizeRepo(recordsDir, slug)).filter(Boolean);

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "🧹 ClawSweeper — digest" } },
    ...(summaries.length === 0
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Aún no hay reviews generadas en el state repo." },
          },
        ]
      : summaries.map(repoBlocks)),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Comandos en issues/PRs: `@clawsweeper status | review | autofix | automerge | stop`",
        },
      ],
    },
  ];

  await postToSlack(blocks);
  process.stderr.write(`[slack-digest] posted (${summaries.length} repos)\n`);
}

await main();
