// Hamelyn review policy knobs.
//
// Upstream ClawSweeper publishes one long durable review comment per item and
// syncs a dozen label families. For a small private team that produced a lot
// of text nobody read. These switches keep every upstream default intact and
// only change behavior when the workflow opts in through environment
// variables, so reverting is a matter of unsetting them in sweep.yml.
//
// - CLAWSWEEPER_COMMENT_POLICY=signal: publish a review comment only when it
//   carries an actionable signal (see reviewSignal), keep it short, and stop
//   syncing the label families listed in isRetiredLabelUnderSignalPolicy.
// - CLAWSWEEPER_PROOF_GATE=off: treat real behavior proof as not applicable;
//   the target repository has its own Proof Agent for that.
// - CLAWSWEEPER_HOT_INTAKE_NEW_ONLY=1: the frequent hot-intake sweep only
//   reviews items that have never been reviewed.
// - CLAWSWEEPER_REVIEW_HUMAN_ACTIVITY_ONLY=1: an already-reviewed item is only
//   re-reviewed after a human comment, a human commit, or a command; bot
//   comments and label churn do not count.
// - CLAWSWEEPER_ACTIVITY_IGNORED_LOGINS: comma-separated GitHub logins treated
//   as automation for the activity check (for accounts that are not [bot]).

export type CommentPolicy = "full" | "signal";

type Env = Record<string, string | undefined>;

export function commentPolicy(env: Env = process.env): CommentPolicy {
  return (env.CLAWSWEEPER_COMMENT_POLICY ?? "").trim().toLowerCase() === "signal"
    ? "signal"
    : "full";
}

export function isSignalCommentPolicy(env: Env = process.env): boolean {
  return commentPolicy(env) === "signal";
}

export function proofGateEnabled(env: Env = process.env): boolean {
  const value = (env.CLAWSWEEPER_PROOF_GATE ?? "").trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

export function hotIntakeNewOnly(env: Env = process.env): boolean {
  return (env.CLAWSWEEPER_HOT_INTAKE_NEW_ONLY ?? "").trim() === "1";
}

export function humanActivityOnly(env: Env = process.env): boolean {
  return (env.CLAWSWEEPER_REVIEW_HUMAN_ACTIVITY_ONLY ?? "").trim() === "1";
}

export function activityIgnoredLogins(env: Env = process.env): Set<string> {
  return new Set(
    (env.CLAWSWEEPER_ACTIVITY_IGNORED_LOGINS ?? "")
      .split(",")
      .map((login) => normalizeLogin(login))
      .filter(Boolean),
  );
}

export function normalizeLogin(login: string | undefined | null): string {
  return (login ?? "")
    .trim()
    .replace(/^@/, "")
    .replace(/\[bot\]$/i, "")
    .toLowerCase();
}

// Findings below this priority or confidence are not worth a comment on
// their own; they stay in the durable report and the weekly digest.
export const SIGNAL_FINDING_MAX_PRIORITY = 2;
export const SIGNAL_FINDING_MIN_CONFIDENCE = 0.6;

export interface ReviewSignalFinding {
  priority: number;
  confidenceScore: number;
}

export interface ReviewSignalFacts {
  isPullRequest: boolean;
  reviewFailed: boolean;
  closeProposal: boolean;
  findings: readonly ReviewSignalFinding[];
  securityNeedsAttention: boolean;
  maintainerDecisionRequired: boolean;
  clusterVisible: boolean;
}

export interface ReviewSignal {
  publish: boolean;
  reasons: string[];
}

export function isSignalFinding(finding: ReviewSignalFinding): boolean {
  return (
    finding.priority <= SIGNAL_FINDING_MAX_PRIORITY &&
    finding.confidenceScore >= SIGNAL_FINDING_MIN_CONFIDENCE
  );
}

export function reviewSignal(facts: ReviewSignalFacts): ReviewSignal {
  if (facts.reviewFailed) return { publish: false, reasons: ["review failed"] };
  const reasons: string[] = [];
  if (facts.closeProposal) reasons.push("close proposal");
  if (facts.securityNeedsAttention) reasons.push("security needs attention");
  if (facts.isPullRequest && facts.findings.some(isSignalFinding)) {
    reasons.push("confident P0-P2 findings");
  }
  if (facts.maintainerDecisionRequired) reasons.push("maintainer decision needed");
  if (facts.clusterVisible) reasons.push("root-cause cluster or duplicate");
  return { publish: reasons.length > 0, reasons };
}

// Labels ClawSweeper keeps writing under the signal policy. Everything else it
// owns (ratings, impact, merge-risk, proof, status, internal advisory state)
// is neither added nor removed; the target repository deletes those label
// families once.
export const SIGNAL_POLICY_KEPT_CLAWSWEEPER_LABELS: ReadonlySet<string> = new Set([
  "clawsweeper:needs-product-decision",
  "clawsweeper:needs-security-review",
  "clawsweeper:human-review",
  "clawsweeper:manual-only",
  "clawsweeper:autofix",
  "clawsweeper:automerge",
]);

export const SIGNAL_POLICY_KEPT_ADVISORY_LABELS: ReadonlySet<string> = new Set([
  "clawsweeper:needs-product-decision",
  "clawsweeper:needs-security-review",
]);

const RETIRED_LABEL_FAMILY_PATTERN =
  /^(?:rating|issue-rating|impact|merge-risk|proof|status|maturity|mantis):/i;

export function isRetiredLabelUnderSignalPolicy(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  if (RETIRED_LABEL_FAMILY_PATTERN.test(normalized)) return true;
  if (normalized === "feature: ✨ showcase") return true;
  if (normalized === "triage: needs-real-behavior-proof") return true;
  if (normalized.startsWith("clawsweeper:")) {
    return !SIGNAL_POLICY_KEPT_CLAWSWEEPER_LABELS.has(normalized);
  }
  return false;
}

export interface ActivityComment {
  authorLogin: string | undefined;
  authorType?: string | undefined;
  createdAt: string | undefined;
}

export interface ActivityCommit {
  sha: string;
  authorLogin: string | undefined;
  committerLogin?: string | undefined;
}

export function isHumanActivityLogin(
  login: string | undefined,
  options: { ignoredLogins?: ReadonlySet<string>; authorType?: string | undefined } = {},
): boolean {
  if (!login) return true;
  if (/\[bot\]$/i.test(login.trim()) || login.startsWith("app/")) return false;
  if ((options.authorType ?? "").toLowerCase() === "bot") return false;
  return !(options.ignoredLogins ?? new Set<string>()).has(normalizeLogin(login));
}

export function hasHumanCommentSince(
  comments: readonly ActivityComment[],
  sinceMs: number,
  ignoredLogins: ReadonlySet<string>,
): boolean {
  return comments.some((comment) => {
    const createdAt = Date.parse(comment.createdAt ?? "");
    if (!Number.isFinite(createdAt) || createdAt <= sinceMs) return false;
    return isHumanActivityLogin(comment.authorLogin, {
      ignoredLogins,
      authorType: comment.authorType,
    });
  });
}

// Commits pushed after the reviewed head. When the reviewed head is not in
// the list (force push, rebase) every commit counts as new.
export function commitsAfterHead(
  commits: readonly ActivityCommit[],
  reviewedHeadSha: string | undefined,
): ActivityCommit[] {
  if (!reviewedHeadSha) return [...commits];
  const index = commits.findIndex((commit) => commit.sha === reviewedHeadSha);
  return index < 0 ? [...commits] : commits.slice(index + 1);
}

export function hasHumanCommitSince(
  commits: readonly ActivityCommit[],
  reviewedHeadSha: string | undefined,
  ignoredLogins: ReadonlySet<string>,
): boolean {
  return commitsAfterHead(commits, reviewedHeadSha).some((commit) =>
    isHumanActivityLogin(commit.authorLogin ?? commit.committerLogin, { ignoredLogins }),
  );
}
