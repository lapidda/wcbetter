import { NextResponse } from "next/server";
import { raidZones } from "@/lib/tank-lookup";

export const runtime = "nodejs";

/** Raid zones with their bosses and difficulties, for pickers that need no report. */
export async function GET() {
  try {
    return NextResponse.json({ zones: await raidZones() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
