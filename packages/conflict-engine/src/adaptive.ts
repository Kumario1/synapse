import type { Conflict, ConflictFeedback } from "@synapse/protocol";

/**
 * Adaptive severity (spec §9 "tunable + learns"): use the team's explicit
 * acted/dismissed feedback to demote warning classes the team chronically
 * dismisses, attacking alarm fatigue (product principle #4 — noisy =
 * uninstalled).
 *
 * Deterministic policy, deliberately one-directional:
 *   - a rule is "chronically dismissed" when it has at least `minDismissals`
 *     dismissals AND a dismiss rate of at least `minDismissRate` among the
 *     feedback that names the rule;
 *   - chronically-dismissed `warn` conflicts are demoted to `info`;
 *   - nothing is ever promoted, and `info` stays `info` — detection is
 *     untouched, only the surfaced volume shrinks.
 */
export interface AdaptiveSeverityOptions {
  /** Minimum dismissals before a rule can demote. Default 5. */
  minDismissals?: number;
  /** Minimum dismissed/(dismissed+acted) rate. Default 0.8. */
  minDismissRate?: number;
}

export interface AdaptiveSeverityResult {
  conflicts: Conflict[];
  /** The rules that were demoted in this pass (for logging/metrics). */
  demotedRules: Conflict["rule"][];
}

export function applyAdaptiveSeverity(
  conflicts: Conflict[],
  feedback: ConflictFeedback[],
  options: AdaptiveSeverityOptions = {}
): AdaptiveSeverityResult {
  const minDismissals = options.minDismissals ?? 5;
  const minDismissRate = options.minDismissRate ?? 0.8;

  const tally = new Map<string, { dismissed: number; acted: number }>();
  for (const entry of feedback) {
    if (!entry.rule) {
      continue;
    }
    let counts = tally.get(entry.rule);
    if (!counts) {
      counts = { dismissed: 0, acted: 0 };
      tally.set(entry.rule, counts);
    }
    if (entry.outcome === "dismissed") {
      counts.dismissed += 1;
    } else {
      counts.acted += 1;
    }
  }

  const chronicallyDismissed = new Set<string>();
  for (const [rule, { dismissed, acted }] of tally) {
    if (dismissed >= minDismissals && dismissed / (dismissed + acted) >= minDismissRate) {
      chronicallyDismissed.add(rule);
    }
  }

  const demotedRules = new Set<Conflict["rule"]>();
  const adjusted = conflicts.map((conflict) => {
    if (conflict.severity !== "warn" || !chronicallyDismissed.has(conflict.rule)) {
      return conflict;
    }
    demotedRules.add(conflict.rule);
    return { ...conflict, severity: "info" as const };
  });

  return { conflicts: adjusted, demotedRules: [...demotedRules] };
}
