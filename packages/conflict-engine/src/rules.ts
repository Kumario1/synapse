import type { Conflict, ConflictRecommendation } from "@synapse/protocol";

/**
 * The per-rule policy floor: for each conflict {@link Conflict.rule}, the
 * default severity surfaced by detection and the matching `recommendation`
 * carried by the deterministic analysis. This is the single auditable place
 * where "how loud is this rule, and what should you do about it" is decided —
 * both detection ({@link evaluateConflicts} in `index.ts`) and explanation
 * ({@link deterministicAnalysis} in `explain.ts`) read severity/recommendation
 * from here instead of repeating the literals inline.
 *
 * The two halves are kept consistent on purpose: a `warn` rule recommends
 * `warn`, an `info` rule recommends `info`. A rule is allowed to *downgrade*
 * itself below this floor for a specific, documented reason (today only
 * `same_symbol_unpushed`, which demotes to `info`/`proceed` for a
 * backward-compatible change). Those overrides live next to the detection code
 * that computes them and read this table as their default.
 *
 * `Record<Conflict["rule"], …>` makes the table exhaustive: adding a rule to
 * the union without a descriptor here is a type error.
 */
export interface RuleDescriptor {
  /** Default surfaced severity for this rule before any state-specific demotion. */
  severity: Conflict["severity"];
  /** The deterministic analysis recommendation paired with that severity. */
  recommendation: ConflictRecommendation;
}

export const ruleDescriptors: Record<Conflict["rule"], RuleDescriptor> = {
  same_symbol_active: { severity: "warn", recommendation: "warn" },
  same_symbol_unpushed: { severity: "warn", recommendation: "warn" },
  contract_divergent: { severity: "warn", recommendation: "warn" },
  dependency_changed: { severity: "warn", recommendation: "warn" },
  transitive_dependency: { severity: "info", recommendation: "info" },
  stale_base: { severity: "warn", recommendation: "warn" },
  same_file_no_overlap: { severity: "info", recommendation: "info" }
};
