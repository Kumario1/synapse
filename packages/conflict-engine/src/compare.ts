import type {
  ContractChange,
  ContractDelta,
  Signature,
  SignatureCompatibility
} from "@synapse/protocol";

export interface SignatureComparison {
  compatibility: SignatureCompatibility;
  reasons: string[];
}

/**
 * Deterministically classify a contract change by comparing the `before` and
 * `after` signatures of a single symbol. This is the high-signal core of
 * conflict detection: it answers "is this change actually breaking?" rather
 * than "did two agents touch the same name?".
 *
 * The classifier is intentionally conservative — anything it cannot prove safe
 * is reported as `breaking` or `unknown`, never silently downgraded.
 */
export function compareSignatures(
  before: Signature | null,
  after: Signature | null
): SignatureComparison {
  if (!before && !after) {
    // A change was reported, but no structured signature was captured (e.g. a
    // summary-only report). We cannot prove it is safe.
    return { compatibility: "unknown", reasons: ["No structured signature was available to classify the change."] };
  }

  if (!before && after) {
    return { compatibility: "compatible", reasons: ["New symbol added; there is no prior contract to break."] };
  }

  if (before && !after) {
    return { compatibility: "breaking", reasons: ["Symbol was removed; existing callers will break."] };
  }

  // Both present.
  if (before!.raw === after!.raw) {
    return { compatibility: "identical", reasons: [] };
  }

  const beforeParams = before!.params ?? [];
  const afterParams = after!.params ?? [];
  const reasons: string[] = [];
  let breaking = false;

  if (afterParams.length < beforeParams.length) {
    breaking = true;
    const removed = beforeParams.length - afterParams.length;
    reasons.push(`Removed ${removed} parameter${removed === 1 ? "" : "s"}.`);
  }

  const positions = Math.max(beforeParams.length, afterParams.length);
  for (let index = 0; index < positions; index += 1) {
    const before_ = beforeParams[index];
    const after_ = afterParams[index];

    if (before_ && after_) {
      if ((before_.type ?? null) !== (after_.type ?? null)) {
        breaking = true;
        reasons.push(
          `Parameter \`${after_.name}\` type changed: ${before_.type ?? "any"} -> ${after_.type ?? "any"}.`
        );
      }

      if (before_.optional && !after_.optional) {
        breaking = true;
        reasons.push(`Parameter \`${after_.name}\` became required.`);
      }
    } else if (!before_ && after_) {
      if (after_.optional) {
        reasons.push(`Added optional parameter \`${after_.name}\`.`);
      } else {
        breaking = true;
        reasons.push(`Added required parameter \`${after_.name}\`.`);
      }
    }
    // before_ && !after_ is covered by the removed-count check above.
  }

  if ((before!.returns ?? null) !== (after!.returns ?? null)) {
    breaking = true;
    reasons.push(`Return type changed: ${before!.returns ?? "void"} -> ${after!.returns ?? "void"}.`);
  }

  if (!breaking && reasons.length === 0) {
    // The raw text differs (e.g. generics, whitespace) but no structural change
    // we recognize — don't claim it is safe.
    return {
      compatibility: "unknown",
      reasons: ["Signature changed in a way that could not be classified structurally."]
    };
  }

  return { compatibility: breaking ? "breaking" : "compatible", reasons };
}

/** Build the structured `ContractChange` attached to delta-derived conflicts. */
export function contractChangeFor(delta: ContractDelta): ContractChange {
  const comparison = compareSignatures(delta.before, delta.after);

  return {
    changeKind: delta.changeKind,
    before: delta.before,
    after: delta.after,
    compatibility: comparison.compatibility,
    breakingReasons: comparison.reasons
  };
}

/** Render a signature for human display, preferring its raw form. */
export function renderSignature(signature: Signature | null): string {
  if (!signature) {
    return "(unknown)";
  }

  if (signature.raw) {
    return signature.raw;
  }

  const params = (signature.params ?? [])
    .map((param) => `${param.name}${param.optional ? "?" : ""}: ${param.type ?? "any"}`)
    .join(", ");

  return `(${params}) => ${signature.returns ?? "void"}`;
}

/** Render a `before -> after` delta, or an empty string when no shapes exist. */
export function renderChange(change: ContractChange | undefined): string {
  if (!change || (!change.before && !change.after)) {
    return "";
  }

  return ` [${renderSignature(change.before)} => ${renderSignature(change.after)}]`;
}

/**
 * A short, human-readable label for a compatibility verdict, used inside
 * conflict details (e.g. "a breaking change", "a backward-compatible change").
 */
export function describeCompatibility(compatibility: SignatureCompatibility): string {
  switch (compatibility) {
    case "breaking":
      return "a breaking change";
    case "compatible":
      return "a backward-compatible change";
    case "identical":
      return "a no-op change";
    case "unknown":
      return "an unclassified change";
  }
}
