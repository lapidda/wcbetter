import { NextResponse } from "next/server";
import type { AnalysisReport } from "@/lib/analyze";
import { generateNarrative } from "@/lib/narrative";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const report = (await request.json()) as AnalysisReport;
    if (!report?.findings) {
      return NextResponse.json({ error: "Send an analysis report body." }, { status: 400 });
    }

    return NextResponse.json({ narrative: await generateNarrative(report) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
