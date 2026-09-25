import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisReport } from "./analyze";

const SYSTEM_PROMPT = `You are an experienced World of Warcraft raid coach reviewing one player's performance across a set of pulls on a single boss.

You will be given a JSON block of findings that were measured from combat logs and compared against the top parses for the same boss, difficulty and specialisation. Those findings are the only facts you have.

Rules:
- Never invent a number, ability, mechanic, talent or timestamp that is not in the findings. If you want to say something you cannot support from the data, leave it out.
- The findings are already ranked by impact discounted for how often they happen. Respect that ranking.
- "seenOnPulls" is the most important field. Something happening on nearly every pull is a habit worth drilling; something that happened once may just be a bad pull. Say which is which.
- Estimated gains are estimates. Say "roughly" or "about"; never promise a parse improvement.
- Some findings are false positives, particularly when the player's talent build differs from the reference parses. Where a finding looks like it might be a talent difference rather than a mistake, say so.
- Write for the player, in second person. Direct and practical, the way a good raid lead talks. No hype, no filler, no bullet-point soup.

Structure your reply as:
1. Two or three sentences on where this player actually stands on this boss.
2. "Fix these first" - the two or three highest-value changes, each with what to do differently on the next pull.
3. "Worth watching" - anything real but lower priority, briefly.
4. One closing sentence naming the single habit to focus on.`;

export async function generateNarrative(report: AnalysisReport): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set, so the coach narrative is unavailable.");
  }

  const client = new Anthropic();

  // Only the fields the coach needs. Sending the full profile would bury the
  // findings in thousands of lines of raw ability rows.
  const payload = {
    encounter: report.encounter,
    pullCount: report.pulls.length,
    kills: report.pulls.filter((p) => p.kill).length,
    player: {
      name: report.player.name,
      spec: `${report.player.specName ?? ""} ${report.player.className ?? ""}`.trim(),
      medianDps: Math.round(report.totals.medianDps),
      bestDps: Math.round(report.totals.bestDps),
      medianActiveTimePct: Number(report.totals.medianActiveTimePct.toFixed(1)),
      totalDeaths: report.totals.deaths,
    },
    reference: {
      medianDps: Math.round(report.reference.medianDps),
      medianActiveTimePct: Number(report.reference.medianActiveTimePct.toFixed(1)),
      parseCount: report.reference.members.length,
    },
    estimatedTotalGainPct: Number(report.estimatedTotalGainPct.toFixed(1)),
    findings: report.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      advice: f.advice,
      metric: f.metric,
      seenOnPulls: `${f.occurrences} of ${f.totalPulls}`,
      evidence: f.evidence.slice(0, 6),
      estimatedGainPct: f.medianGainPct ? Number(f.medianGainPct.toFixed(1)) : undefined,
    })),
  };

  const response = await client.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If the safety classifier declines, the same request is re-run on the
    // fallback model inside this call rather than simply failing.
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    messages: [
      {
        role: "user",
        content: `Findings for this pull:\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The coach narrative could not be generated for this report.");
  }

  return response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
