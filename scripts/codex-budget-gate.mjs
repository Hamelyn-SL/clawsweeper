#!/usr/bin/env node
// Subscription budget gate. Reads live usage for the shared ChatGPT/Codex
// subscription and decides whether a sweep run may spend model time now.
//
// Exit 0  -> headroom available, proceed.
// Exit 1  -> the binding window is too hot (or usage unknowable): skip this run.
//            On Pro plans the endpoint reports a single primary window of 10080
//            minutes (the weekly one) and no secondary window, so MAX_5H is in
//            practice the share of the WEEK this bot may spend: the rest of the
//            week must stay free for Asamblea, Proof, Guardian and the watchers.
//            The schedule keeps ticking, so work resumes automatically on the
//            first tick after the window resets — no state, no daemon.
//
// Env: CODEX_TOKEN_BLOB_URL, CODEX_TOKEN_KEY (same secrets as the proxy),
//      CLAWSWEEPER_BUDGET_MAX_5H (default 30, primary window),
//      CLAWSWEEPER_BUDGET_MAX_WEEKLY (default 85, secondary window when present).

import { createDecipheriv } from "node:crypto";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_5H = Number(process.env.CLAWSWEEPER_BUDGET_MAX_5H ?? 30);
const MAX_WEEKLY = Number(process.env.CLAWSWEEPER_BUDGET_MAX_WEEKLY ?? 85);

function fail(message) {
  console.log(`budget-gate: ${message} -> skip run`);
  process.exit(1);
}

function decryptTokens(buf, keyHex) {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8"),
  );
}

const blobUrl = process.env.CODEX_TOKEN_BLOB_URL;
const keyHex = process.env.CODEX_TOKEN_KEY;
if (!blobUrl || !keyHex) fail("CODEX_TOKEN_BLOB_URL/CODEX_TOKEN_KEY missing");

let usage;
try {
  const blob = await fetch(blobUrl, { cache: "no-store" });
  if (!blob.ok) fail(`token blob download failed (${blob.status})`);
  const tokens = decryptTokens(Buffer.from(await blob.arrayBuffer()), keyHex);
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "ChatGPT-Account-ID": tokens.account_id,
      originator: "codex_cli_rs",
    },
  });
  if (!res.ok) fail(`usage endpoint returned ${res.status}`);
  usage = await res.json();
} catch (err) {
  fail(`usage lookup failed (${err instanceof Error ? err.message : String(err)})`);
}

const primary = usage?.rate_limit?.primary_window?.used_percent;
const secondary = usage?.rate_limit?.secondary_window?.used_percent ?? 0;
const primaryMinutes = usage?.rate_limit?.primary_window?.window_minutes;
const resetMin = Math.ceil((usage?.rate_limit?.primary_window?.reset_after_seconds ?? 0) / 60);
if (typeof primary !== "number") fail("no primary_window.used_percent in response");

const primaryLabel = typeof primaryMinutes === "number" ? `${primaryMinutes}m window` : "primary";
console.log(
  `budget-gate: 5h=${primary}% (max ${MAX_5H}%, ${primaryLabel}), weekly=${secondary}% (max ${MAX_WEEKLY}%), 5h reset in ~${resetMin}m`,
);
if (primary >= MAX_5H) fail(`primary window at ${primary}%`);
if (secondary >= MAX_WEEKLY) fail(`secondary window at ${secondary}%`);
console.log("budget-gate: headroom OK, proceeding");
