import assert from "node:assert/strict";
import test from "node:test";

import { buildDigest, parseFindings } from "../scripts/slack-digest.mjs";

function record(
  overrides: Record<string, unknown> = {},
  findings = "- none",
): Record<string, unknown> {
  const base = {
    repository: "hamelyn-sl/hamelyn-serverless",
    number: 8488,
    type: "pull_request",
    title: "fix: isolate promo strip assignment from cached shell",
    url: "https://github.com/Hamelyn-SL/hamelyn-serverless/pull/8488",
    reviewed_at: "2026-08-17T21:34:59.699Z",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    triage_priority: "P2",
    requires_product_decision: "false",
    maintainer_decision: "none",
    ...overrides,
  };
  const markdown = [
    "---",
    ...Object.entries(base).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    "## Summary",
    "",
    "Resumen.",
    "",
    "## Review Findings",
    "",
    "Overall correctness: patch is incorrect",
    "",
    "Full review comments:",
    "",
    findings,
    "",
    "## Security Review",
    "",
    "Status: cleared",
    "",
  ].join("\n");
  return { ...base, markdown };
}

const P1 = [
  "- **[P1] No cierres la incidencia con una causa descartada:** `apps/hamelyn-ecommerce/app/layout.tsx:151`",
  "  - body: La incidencia enlazada ya documenta que el fallback no era el #418.",
  "  - confidence: 0.98",
].join("\n");
const P2 = [
  "- **[P2] Tipado laxo:** `apps/hamelyn-ecommerce/app/layout.tsx:12-14`",
  "  - body: Usa unknown.",
  "  - confidence: 0.9",
].join("\n");

test("parseFindings reads priority, location and confidence from the report section", () => {
  const findings = parseFindings(record({}, [P1, P2].join("\n")).markdown as string);
  assert.deepEqual(findings, [
    {
      priority: 1,
      title: "No cierres la incidencia con una causa descartada",
      location: "apps/hamelyn-ecommerce/app/layout.tsx:151",
      confidence: 0.98,
    },
    {
      priority: 2,
      title: "Tipado laxo",
      location: "apps/hamelyn-ecommerce/app/layout.tsx:12-14",
      confidence: 0.9,
    },
  ]);
  assert.deepEqual(parseFindings(record({}).markdown as string), []);
});

test("buildDigest lists decisions with owners, unanswered P0-P1 findings and proposed closes", () => {
  const decision = JSON.stringify({
    required: true,
    kind: "product_direction",
    question: "¿Debe el catálogo público exponer el desglose de ofertas?",
    rationale: "Cambia una API pública.",
    options: [
      {
        title: "Mantener el catálogo mínimo",
        body: "Solo ajustes de descubrimiento.",
        recommended: true,
      },
      { title: "Diseñar el desglose", body: "Definir campos y caché.", recommended: false },
    ],
    likelyOwner: {
      person: "JavierHamelyn",
      reason: "Desarrolló la superficie.",
      confidence: "high",
    },
  });
  const items = [
    record({
      number: 8631,
      type: "issue",
      url: "https://github.com/Hamelyn-SL/hamelyn-serverless/issues/8631",
      title: "Agent readiness 100/100",
      triage_priority: "P2",
      requires_product_decision: "true",
      maintainer_decision: decision,
    }),
    record({ number: 8488 }, P1),
    record({ number: 8500, title: "fix: answered already" }, P1),
    record({ number: 8501, title: "fix: only P2" }, P2),
    record({
      number: 7000,
      type: "issue",
      url: "https://github.com/Hamelyn-SL/hamelyn-serverless/issues/7000",
      title: "Old request",
      decision: "close",
      close_reason: "implemented_on_main",
    }),
  ];
  const humanReplies = new Map<number, boolean>([
    [8488, false],
    [8500, true],
  ]);
  const { blocks, counts } = buildDigest({
    items,
    humanReplies,
    mentionMap: { JavierHamelyn: "U03S59X3FK5" },
    days: 7,
  });
  assert.deepEqual(counts, { decisions: 1, findings: 1, proposals: 1 });
  const text = blocks
    .map((block: { text?: { text?: string } }) => block.text?.text ?? "")
    .join("\n");
  assert.match(text, /\*1\. Decisiones de producto pendientes\*/);
  assert.match(
    text,
    /<https:\/\/github\.com\/Hamelyn-SL\/hamelyn-serverless\/issues\/8631\|issue #8631> Agent readiness 100\/100 — ¿Debe el catálogo público exponer el desglose de ofertas\? → <@U03S59X3FK5>\. Recomendación: _Mantener el catálogo mínimo_\./,
  );
  assert.match(text, /\*2\. Hallazgos P0-P1 sin respuesta\*/);
  assert.match(text, /PR #8488> fix: isolate promo strip[^\n]*\[P1\] No cierres la incidencia/);
  assert.doesNotMatch(text, /PR #8500>/);
  assert.doesNotMatch(text, /PR #8501>/);
  assert.match(
    text,
    /\*3\. Cierres propuestos\*[\s\S]*issue #7000> Old request — `implemented_on_main` \(high\)/,
  );
  assert.match(
    text,
    /5 issues\/PRs abiertos con revisión · 1 decisiones pendientes · 1 PRs con hallazgos P0-P1 sin respuesta · 1 cierres propuestos/,
  );
});

test("buildDigest marks unchecked replies and falls back to plain logins", () => {
  const items = [record({ number: 8488 }, P1)];
  const { blocks } = buildDigest({ items, humanReplies: new Map(), mentionMap: {}, days: 7 });
  const text = blocks
    .map((block: { text?: { text?: string } }) => block.text?.text ?? "")
    .join("\n");
  assert.match(text, /respuesta sin comprobar/);
  assert.match(text, /Ninguna\. 🎉/);
});
