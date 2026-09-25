import { NextResponse } from "next/server";
import { summarizeReport } from "@/lib/analyze";
import { parseReportInput } from "@/lib/wcl/fetchers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams.get("input");
  if (!input) {
    return NextResponse.json({ error: "Pass a report URL or code as ?input=" }, { status: 400 });
  }

  try {
    const { code, fightId, sourceId } = parseReportInput(input);
    return NextResponse.json(await summarizeReport(code, { fightId, sourceId }));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
