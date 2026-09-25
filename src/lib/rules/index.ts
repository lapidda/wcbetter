import { activeTime } from "./active-time";
import { avoidableDamage } from "./avoidable-damage";
import { burn } from "./burn";
import { consumables } from "./consumables";
import { castFrequency } from "./cast-frequency";
import { deaths } from "./deaths";
import { missedCooldowns } from "./missed-cooldowns";
import { opener } from "./opener";
import type { Finding, Rule, RuleContext, Severity } from "./types";

/** Adding an analysis is one file plus one line here. */
export const RULES: Rule[] = [
  missedCooldowns,
  opener,
  burn,
  castFrequency,
  activeTime,
  avoidableDamage,
  deaths,
  consumables,
];

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export function runRules(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const rule of RULES) {
    try {
      findings.push(...rule.run(ctx));
    } catch (error) {
      // One broken rule should degrade the report, not destroy it.
      findings.push({
        id: `error:${rule.id}`,
        rule: rule.id,
        severity: "info",
        title: `Rule "${rule.name}" failed to run`,
        detail: (error as Error).message,
        advice: "The remaining findings are unaffected.",
        evidence: [],
      });
    }
  }

  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (b.estimatedGainPct ?? 0) - (a.estimatedGainPct ?? 0);
  });
}

export type { Finding, Rule, RuleContext, Severity } from "./types";
