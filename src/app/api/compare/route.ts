import type { CompareArgs } from "@/lib/model/spec-compare";
import { compareSpecs } from "@/lib/spec-compare";

export const runtime = "nodejs";
/** Many specs across a whole raid and two difficulties, cold, is a lot of pages. */
export const maxDuration = 800;

/** Streams progress as server-sent events, like /api/raid. */
export async function POST(request: Request) {
  const body = (await request.json()) as Partial<CompareArgs>;
  if (!body.zoneId || !body.difficulties?.length || !body.columns?.length || !body.topN) {
    return Response.json({ error: "zoneId, difficulties, columns and topN are required" }, { status: 400 });
  }
  const args: CompareArgs = {
    zoneId: body.zoneId,
    difficulties: body.difficulties,
    columns: body.columns,
    days: body.days ?? null,
    topN: body.topN,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        send("report", await compareSpecs(args, (message) => send("progress", { message })));
      } catch (error) {
        send("error", { message: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
