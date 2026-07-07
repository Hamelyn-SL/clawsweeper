#!/usr/bin/env node
// Local Responses proxy backed by a ChatGPT/Codex subscription instead of an
// OpenAI API key. Drop-in sibling of @openai/codex-responses-api-proxy: it
// listens on 127.0.0.1, speaks the Responses wire API, and forwards to the
// Codex backend at chatgpt.com with subscription auth. Codex subprocesses only
// ever see the local port — never the access token.
//
// The access token lives AES-256-GCM encrypted in a Vercel Blob maintained by
// the marketplace-agents refresh cron (see that repo's agent/lib/codex-token.ts,
// which owns seeding and rotation). This proxy is read-only: it never refreshes
// the token itself, because the OAuth refresh_token rotates single-use and two
// writers would race.
//
// Credentials arrive on stdin as JSON ({ blob_url, key_hex }) so they stay out
// of argv and the environment. Usage:
//   echo '{"blob_url":"...","key_hex":"..."}' \
//     | node scripts/chatgpt-subscription-proxy.mjs --server-info <path>
//   node scripts/chatgpt-subscription-proxy.mjs --self-test  (stdin JSON too)

import { createDecipheriv } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";

const UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "openai-beta",
  "session_id",
  "conversation_id",
];
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const TOKEN_SKEW_MS = 60_000;
const RETRY_DELAY_MS = 2_000;

function log(message) {
  process.stderr.write(`[subscription-proxy] ${message}\n`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) fail("expected credentials JSON on stdin ({ blob_url, key_hex })");
  try {
    return JSON.parse(raw);
  } catch {
    return fail("stdin was not valid JSON");
  }
}

function decryptTokens(buf, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) fail("key_hex must be 32 bytes of hex (AES-256-GCM)");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  return JSON.parse(json);
}

async function fetchTokens({ blob_url: blobUrl, key_hex: keyHex }) {
  if (!blobUrl || !keyHex) fail("credentials JSON needs blob_url and key_hex");
  const res = await fetch(blobUrl, { cache: "no-store" });
  if (!res.ok) fail(`token blob download failed: ${res.status}`);
  const tokens = decryptTokens(Buffer.from(await res.arrayBuffer()), keyHex);
  if (!tokens.access_token || !tokens.account_id) {
    fail("decrypted blob is missing access_token/account_id");
  }
  return tokens;
}

function tokenRemainingMs(tokens) {
  return Number(tokens.expires_at ?? 0) - Date.now();
}

function assertTokenAlive(tokens) {
  if (tokenRemainingMs(tokens) > TOKEN_SKEW_MS) return;
  fail(
    "subscription access token is expired — the marketplace-agents refresh-token " +
      "cron has stopped rotating it (check codex/health.json in the Blob store)",
  );
}

// Mirrors the request adaptations validated in marketplace-agents/agent/agent.ts:
// the stateless Codex backend requires store:false, returns reasoning only as
// encrypted content, 404s on by-id item_reference inputs, and has no service
// tiers. Returns a new object; the parsed input is never mutated.
function adaptRequestBody(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody; // non-JSON: forward untouched, let upstream reject it
  }
  const { service_tier: _serviceTier, ...rest } = parsed;
  const include = Array.from(new Set([...(rest.include ?? []), "reasoning.encrypted_content"]));
  const input = Array.isArray(rest.input)
    ? rest.input.filter(
        (item) =>
          item?.type !== "item_reference" &&
          !(item?.type === "reasoning" && !item.encrypted_content),
      )
    : rest.input;
  return JSON.stringify({
    ...rest,
    store: false,
    include,
    ...(input !== undefined ? { input } : {}),
  });
}

function upstreamHeaders(clientHeaders, tokens) {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = clientHeaders[name];
    if (typeof value === "string" && value) headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("Authorization", `Bearer ${tokens.access_token}`);
  headers.set("ChatGPT-Account-ID", tokens.account_id);
  headers.set("originator", "codex_cli_rs");
  return headers;
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error(`request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function forwardWithRetry(body, headers) {
  const request = () => fetch(UPSTREAM_URL, { method: "POST", headers, body });
  let response = await request();
  if (response.status >= 500) {
    log(`upstream ${response.status}, retrying once`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    response = await request();
  }
  return response;
}

async function main() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");
  const serverInfoIndex = args.indexOf("--server-info");
  const serverInfoPath = serverInfoIndex >= 0 ? args[serverInfoIndex + 1] : null;
  if (!selfTest && !serverInfoPath) fail("usage: --server-info <path> | --self-test");

  const credentials = await readStdinJson();
  let tokens = await fetchTokens(credentials);
  assertTokenAlive(tokens);
  const remainingHours = Math.round(tokenRemainingMs(tokens) / 3_600_000);
  log(`token ok for account ${tokens.account_id.slice(0, 8)}…, ~${remainingHours}h remaining`);
  if (remainingHours < 12) log("warning: under 12h left — check the refresh cron soon");

  if (selfTest) {
    process.stdout.write(JSON.stringify({ ok: true, expires_at: tokens.expires_at }) + "\n");
    return;
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/shutdown") {
        res.writeHead(200).end("bye");
        server.close(() => process.exit(0));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "subscription proxy only serves POST …/responses" }));
        return;
      }
      if (tokenRemainingMs(tokens) <= TOKEN_SKEW_MS) {
        tokens = await fetchTokens(credentials); // cron may have rotated it
        assertTokenAlive(tokens);
      }
      const started = Date.now();
      const body = adaptRequestBody(await readRequestBody(req));
      const upstream = await forwardWithRetry(body, upstreamHeaders(req.headers, tokens));
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(res);
        res.on("close", () => log(`${upstream.status} in ${Date.now() - started}ms`));
      } else {
        res.end();
      }
    } catch (err) {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "subscription proxy upstream failure" }));
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    writeFileSync(serverInfoPath, JSON.stringify({ port }), { mode: 0o600 });
    log(`listening on 127.0.0.1:${port}`);
  });
}

await main();
