import type { Conflict } from "@synapse/protocol";

/**
 * Branch-aware severity (plan M6.5, first slice of the F2/F4/F5 branch
 * awareness backlog): when the conflicting work lives on a *different* branch
 * than the checking session, `dependency_changed` and `stale_base` are less
 * immediately pressing — the dependency/base divergence only bites at merge
 * time, not on the next keystroke — so their `warn` is demoted to `info`.
 *
 * Deliberately conservative, mirroring `applyAdaptiveSeverity`:
 *   - `same_symbol_active`, `same_symbol_unpushed`, and `contract_divergent`
 *     are never demoted — incompatible contracts surface at merge regardless
 *     of which branches they were written on;
 *   - unknown branch on either side (old clients, detached HEAD, no git) →
 *     no change;
 *   - nothing is ever promoted; detection is untouched.
 */
const CROSS_BRANCH_DEMOTABLE: ReadonlySet<Conflict["rule"]> = new Set([
  "dependency_changed",
  "stale_base"
]);

export interface BranchAwarenessResult {
  conflicts: Conflict[];
  /** The rules that were demoted in this pass (for logging/metrics). */
  demotedRules: Conflict["rule"][];
}

export function applyBranchAwareness(
  conflicts: Conflict[],
  selfBranch: string | undefined
): BranchAwarenessResult {
  if (!selfBranch) {
    return { conflicts, demotedRules: [] };
  }

  const demotedRules = new Set<Conflict["rule"]>();
  const adjusted = conflicts.map((conflict) => {
    const counterpartBranch = conflict.counterpart.branch;
    if (
      conflict.severity !== "warn" ||
      !CROSS_BRANCH_DEMOTABLE.has(conflict.rule) ||
      !counterpartBranch ||
      counterpartBranch === selfBranch
    ) {
      return conflict;
    }
    demotedRules.add(conflict.rule);
    return { ...conflict, severity: "info" as const };
  });

  return { conflicts: adjusted, demotedRules: [...demotedRules] };
}
