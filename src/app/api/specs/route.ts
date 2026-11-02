import { NextResponse } from "next/server";
import { listSpecs } from "@/lib/talents/talent-data";

export const runtime = "nodejs";

/** Every class, spec and hero tree, for pickers. */
export async function GET() {
  try {
    return NextResponse.json({ specs: await listSpecs() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
