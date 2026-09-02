import assert from "node:assert/strict";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  reviewSignalFromReport,
  signalPolicyWithholdReason,
} from "../dist/clawsweeper.js";
import {
  activityIgnoredLogins,
  commitsAfterHead,
  hasHumanCommentSince,
  hasHumanCommitSince,
  hotIntakeNewOnly,
  humanActivityOnly,
  isRetiredLabelUnderSignalPolicy,
  isSignalCommentPolicy,
  proofGateEnabled,
  reviewSignal,
} from "../dist/review-policy.js";

const POLICY_ENV_KEYS = [
  "CLAWSWEEPER_COMMENT_POLICY",
  "CLAWSWEEPER_PROOF_GATE",
  "CLAWSWEEPER_HOT_INTAKE_NEW_ONLY",
  "CLAWSWEEPER_REVIEW_HUMAN_ACTIVITY_ONLY",
  "CLAWSWEEPER_ACTIVITY_IGNORED_LOGINS",
];

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(POLICY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of POLICY_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of POLICY_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function report(options: {
  type?: "issue" | "pull_request";
  decision?: string;
  closeReason?: string;
  reviewStatus?: string;
  findings?: string;
  security?: string;
  maintainerDecision?: string;
  cluster?: string;
  summary?: string;
  authorAssociation?: string;
}): string {
  const type = options.type ?? "pull_request";
  const number = 4242;
  const frontmatter = {
    repository: "hamelyn-sl/hamelyn-serverless",
    number,
    type,
    title: "fix: keep carrier switch atomic",
    url: `https://github.com/Hamelyn-SL/hamelyn-serverless/${type === "pull_request" ? "pull" : "issues"}/${number}`,
    author: "MarcosTerroso",
    author_association: options.authorAssociation ?? "MEMBER",
    reviewed_at: "2026-09-01T10:00:00.000Z",
    item_updated_at: "2026-09-01T09:00:00Z",
    pull_head_sha: type === "pull_request" ? "abcdef1234567890abcdef1234567890abcdef12" : "unknown",
    review_status: options.reviewStatus ?? "complete",
    decision: options.decision ?? "keep_open",
    close_reason: options.closeReason ?? "none",
    confidence: "high",
    work_candidate: "none",
    triage_priority: "P2",
    requires_product_decision: options.maintainerDecision ? "true" : "false",
    maintainer_decision: options.maintainerDecision ?? "none",
    root_cause_cluster: options.cluster ?? "none",
    labels: JSON.stringify(["P2"]),
  };
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    "## Summary",
    "",
    options.summary ??
      "La PR hace atómico el cambio de transportista, pero deja una carrera en la persistencia de la etiqueta.",
    "",
    "## What This Changes",
    "",
    "Serializa el cambio de transportista con un claim previo sobre el pedido.",
    "",
    "## Review Findings",
    "",
    "Overall correctness: patch is correct",
    "",
    "Overall confidence: 0.9",
    "",
    "Full review comments:",
    "",
    options.findings ?? "- none",
    "",
    "## Security Review",
    "",
    options.security ??
      [
        "Status: cleared",
        "",
        "Summary: Sin cambios de dependencias ni permisos.",
        "",
        "Concerns:",
        "",
        "- none",
      ].join("\n"),
    "",
    "## Real Behavior Proof",
    "",
    "Status: missing",
    "",
    "Evidence kind: none",
    "",
    "Needs contributor action: true",
    "",
    "Summary: Falta una ejecución real del flujo de Admin.",
    "",
  ].join("\n");
}

const P1_FINDING = [
  "- **[P1] Carrera al persistir la etiqueta:** `packages/core/src/shipping/switch.ts:120-131`",
  "  - body: El claim se libera antes de escribir la etiqueta, así que dos operarios pueden pisarse.",
  "  - confidence: 0.92",
].join("\n");

const P3_FINDING = [
  "- **[P3] Nombre poco claro:** `packages/core/src/shipping/switch.ts:12`",
  "  - body: `x` debería llamarse `claimedOrder`.",
  "  - confidence: 0.95",
].join("\n");

const LOW_CONFIDENCE_P1 = [
  "- **[P1] Posible doble envío:** `packages/core/src/shipping/switch.ts:40`",
  "  - body: No estoy seguro de que el reintento sea idempotente.",
  "  - confidence: 0.3",
].join("\n");

const DECISION = JSON.stringify({
  required: true,
  kind: "product_direction",
  question: "¿Debe Admin permitir el cambio manual desde LABEL_ISSUE o solo desde picking?",
  rationale: "Amplía un contrato operativo que hoy está restringido a propósito.",
  options: [
    {
      title: "Permitirlo con evidencia",
      body: "Aceptar el estado y pedir una prueba real.",
      recommended: true,
    },
    {
      title: "Mantener la restricción",
      body: "Cerrar la PR y documentar el motivo.",
      recommended: false,
    },
  ],
  likelyOwner: {
    person: "JavierHamelyn",
    reason: "Definió la política actual.",
    confidence: "high",
  },
});

const CLUSTER = JSON.stringify({
  confidence: "high",
  canonicalRef: "https://github.com/hamelyn-sl/hamelyn-serverless/issues/8652",
  currentItemRelationship: "duplicate",
  summary: "Misma causa raíz que la incidencia canónica.",
  members: [
    {
      ref: "https://github.com/hamelyn-sl/hamelyn-serverless/issues/8652",
      relationship: "canonical",
      reason: "Describe el mismo bloqueo operativo.",
    },
  ],
});

test("policy switches default to upstream behavior", () => {
  withEnv({}, () => {
    assert.equal(isSignalCommentPolicy(), false);
    assert.equal(proofGateEnabled(), true);
    assert.equal(hotIntakeNewOnly(), false);
    assert.equal(humanActivityOnly(), false);
    assert.deepEqual([...activityIgnoredLogins()], []);
  });
  withEnv(
    {
      CLAWSWEEPER_COMMENT_POLICY: "signal",
      CLAWSWEEPER_PROOF_GATE: "off",
      CLAWSWEEPER_HOT_INTAKE_NEW_ONLY: "1",
      CLAWSWEEPER_REVIEW_HUMAN_ACTIVITY_ONLY: "1",
      CLAWSWEEPER_ACTIVITY_IGNORED_LOGINS: "HamelynDev, @lyno-bot[bot]",
    },
    () => {
      assert.equal(isSignalCommentPolicy(), true);
      assert.equal(proofGateEnabled(), false);
      assert.equal(hotIntakeNewOnly(), true);
      assert.equal(humanActivityOnly(), true);
      assert.deepEqual([...activityIgnoredLogins()], ["hamelyndev", "lyno-bot"]);
    },
  );
});

test("review signal needs a confident P0-P2 finding, a decision, a cluster, security or a close", () => {
  const base = {
    isPullRequest: true,
    reviewFailed: false,
    closeProposal: false,
    findings: [],
    securityNeedsAttention: false,
    maintainerDecisionRequired: false,
    clusterVisible: false,
  };
  assert.equal(reviewSignal(base).publish, false);
  assert.equal(
    reviewSignal({ ...base, findings: [{ priority: 3, confidenceScore: 0.99 }] }).publish,
    false,
  );
  assert.equal(
    reviewSignal({ ...base, findings: [{ priority: 1, confidenceScore: 0.3 }] }).publish,
    false,
  );
  assert.equal(
    reviewSignal({ ...base, findings: [{ priority: 1, confidenceScore: 0.9 }] }).publish,
    true,
  );
  assert.equal(
    reviewSignal({
      ...base,
      isPullRequest: false,
      findings: [{ priority: 1, confidenceScore: 0.9 }],
    }).publish,
    false,
  );
  assert.equal(reviewSignal({ ...base, maintainerDecisionRequired: true }).publish, true);
  assert.equal(reviewSignal({ ...base, clusterVisible: true }).publish, true);
  assert.equal(reviewSignal({ ...base, securityNeedsAttention: true }).publish, true);
  assert.equal(reviewSignal({ ...base, closeProposal: true }).publish, true);
  assert.equal(reviewSignal({ ...base, closeProposal: true, reviewFailed: true }).publish, false);
});

test("retired label families stop at the labels a person acts on", () => {
  for (const label of [
    "rating: 🥈 silver",
    "issue-rating: 💎 diamond",
    "impact:other",
    "merge-risk: 🚨 compatibility",
    "proof: sufficient",
    "status: 📣 needs proof",
    "clawsweeper:no-new-fix-pr",
    "clawsweeper:linked-pr-open",
    "feature: ✨ showcase",
  ]) {
    assert.equal(isRetiredLabelUnderSignalPolicy(label), true, label);
  }
  for (const label of [
    "P1",
    "size/M",
    "surface:pdp",
    "clawsweeper:needs-product-decision",
    "clawsweeper:needs-security-review",
    "clawsweeper:human-review",
    "bug",
  ]) {
    assert.equal(isRetiredLabelUnderSignalPolicy(label), false, label);
  }
});

test("human activity ignores bots, ignored logins and pre-review comments", () => {
  const since = Date.parse("2026-09-01T10:00:00Z");
  const ignored = new Set(["hamelyndev"]);
  assert.equal(
    hasHumanCommentSince(
      [
        {
          authorLogin: "clawsweeper-hamelyn[bot]",
          authorType: "Bot",
          createdAt: "2026-09-01T11:00:00Z",
        },
        { authorLogin: "vercel[bot]", authorType: "Bot", createdAt: "2026-09-01T11:00:00Z" },
        { authorLogin: "HamelynDev", authorType: "User", createdAt: "2026-09-01T11:00:00Z" },
        { authorLogin: "MarcosTerroso", authorType: "User", createdAt: "2026-09-01T09:00:00Z" },
      ],
      since,
      ignored,
    ),
    false,
  );
  assert.equal(
    hasHumanCommentSince(
      [{ authorLogin: "MarcosTerroso", authorType: "User", createdAt: "2026-09-01T11:00:00Z" }],
      since,
      ignored,
    ),
    true,
  );
  const commits = [
    { sha: "aaa", authorLogin: "HamelynDev" },
    { sha: "bbb", authorLogin: "HamelynDev" },
    { sha: "ccc", authorLogin: "MiguelHamelyn" },
  ];
  assert.deepEqual(
    commitsAfterHead(commits, "aaa").map((commit) => commit.sha),
    ["bbb", "ccc"],
  );
  assert.equal(hasHumanCommitSince(commits, "bbb", ignored), true);
  assert.equal(hasHumanCommitSince(commits.slice(0, 2), "aaa", ignored), false);
  assert.equal(hasHumanCommitSince(commits, "missing-head", ignored), true);
  assert.equal(hasHumanCommitSince([{ sha: "ddd", authorLogin: undefined }], "aaa", ignored), true);
});

test("signal comment stays short and keeps only actionable sections", () => {
  withEnv({ CLAWSWEEPER_COMMENT_POLICY: "signal", CLAWSWEEPER_PROOF_GATE: "off" }, () => {
    const markdown = report({
      findings: [P1_FINDING, P3_FINDING, LOW_CONFIDENCE_P1].join("\n"),
      maintainerDecision: DECISION,
      cluster: CLUSTER,
    });
    const signal = reviewSignalFromReport(markdown);
    assert.equal(signal.publish, true);
    assert.deepEqual(signal.reasons, [
      "confident P0-P2 findings",
      "maintainer decision needed",
      "root-cause cluster or duplicate",
    ]);

    const body = renderReviewCommentFromReport(markdown, "none");
    const visible = body.split("<!--")[0] ?? body;
    assert.match(body, /^Codex review: hallazgos antes del merge\./);
    assert.match(
      body,
      /\*\*Hallazgos\*\*\n- \[P1\] Carrera al persistir la etiqueta — `packages\/core\/src\/shipping\/switch\.ts:120-131` \(confianza 0\.92\)/,
    );
    assert.doesNotMatch(body, /Nombre poco claro/);
    assert.doesNotMatch(body, /Posible doble envío/);
    assert.match(
      body,
      /\*\*Decisión pendiente\*\*\n¿Debe Admin permitir[^\n]*Dueño probable: JavierHamelyn\./,
    );
    assert.match(body, /- \*\*Permitirlo con evidencia \(recomendada\):\*\* Aceptar el estado/);
    assert.match(
      body,
      /\*\*Clúster de causa raíz\*\*\nRelación `duplicate` con https:\/\/github\.com\/hamelyn-sl\/hamelyn-serverless\/issues\/8652\./,
    );
    for (const removed of [
      "Merge readiness",
      "Rank-up moves",
      "Label changes",
      "Evidence reviewed",
      "Likely related people",
      "real behavior proof",
      "Copy recommended automerge instruction",
      "Review details",
    ]) {
      assert.doesNotMatch(body, new RegExp(removed, "i"), removed);
    }
    assert.match(
      body,
      /<!-- clawsweeper-verdict:needs-human item=4242 sha=abcdef1234567890abcdef1234567890abcdef12/,
    );
    assert.ok(visible.length < 1500, `visible body is ${visible.length} chars`);
  });
});

test("signal policy withholds needs-human comments without findings and keeps failed reviews quiet", () => {
  withEnv({ CLAWSWEEPER_COMMENT_POLICY: "signal", CLAWSWEEPER_PROOF_GATE: "off" }, () => {
    const quiet = report({});
    assert.equal(reviewSignalFromReport(quiet).publish, false);
    assert.match(
      signalPolicyWithholdReason({
        markdown: quiet,
        hasExistingReviewComment: false,
        stalePullRequestHead: false,
      }) ?? "",
      /no actionable signal/,
    );
    assert.equal(
      signalPolicyWithholdReason({
        markdown: quiet,
        hasExistingReviewComment: true,
        stalePullRequestHead: false,
      }),
      null,
    );
    assert.match(
      signalPolicyWithholdReason({
        markdown: quiet,
        hasExistingReviewComment: true,
        stalePullRequestHead: true,
      }) ?? "",
      /PR head moved/,
    );
    const failed = report({ reviewStatus: "failed", findings: P1_FINDING });
    assert.match(
      signalPolicyWithholdReason({
        markdown: failed,
        hasExistingReviewComment: true,
        stalePullRequestHead: false,
      }) ?? "",
      /review failed/,
    );
    const withFinding = report({ findings: P1_FINDING });
    assert.equal(
      signalPolicyWithholdReason({
        markdown: withFinding,
        hasExistingReviewComment: false,
        stalePullRequestHead: false,
      }),
      null,
    );
  });
});

test("proof gate off never blocks a PR on proof and the upstream comment still shows proof when on", () => {
  withEnv({ CLAWSWEEPER_COMMENT_POLICY: "signal", CLAWSWEEPER_PROOF_GATE: "off" }, () => {
    const body = renderReviewCommentFromReport(report({ findings: P1_FINDING }), "none");
    assert.doesNotMatch(body, /needs real behavior proof/i);
    assert.doesNotMatch(body, /prueba/i);
  });
  withEnv({}, () => {
    const body = renderReviewCommentFromReport(
      report({ findings: P1_FINDING, authorAssociation: "NONE" }),
      "none",
    );
    assert.match(body, /^Codex review: needs real behavior proof before merge\./);
    assert.match(body, /\*\*Merge readiness\*\*/);
  });
});

test("close proposals and issue decisions render as short Spanish signal comments", () => {
  withEnv({ CLAWSWEEPER_COMMENT_POLICY: "signal", CLAWSWEEPER_PROOF_GATE: "off" }, () => {
    const close = renderReviewCommentFromReport(
      report({ type: "issue", decision: "close", closeReason: "implemented_on_main" }),
      "implemented_on_main",
    );
    assert.match(
      close,
      /^Codex review: propone cerrar \(ya está implementado en la rama principal\)\./,
    );
    assert.match(
      close,
      /\*\*Cierre propuesto\*\*\nMotivo: `implemented_on_main`\. Es una propuesta: nada se cierra automáticamente/,
    );
    assert.doesNotMatch(close, /What I checked/);

    const decision = renderReviewCommentFromReport(
      report({ type: "issue", maintainerDecision: DECISION }),
      "none",
    );
    assert.match(decision, /^Codex review: hace falta una decisión del equipo\./);
    assert.doesNotMatch(decision, /\*\*Hallazgos\*\*/);
    assert.doesNotMatch(decision, /clawsweeper-verdict/);
  });
});
