import { analyzeEncounter } from "@/lib/analyze";

export const runtime = "nodejs";
/** Profiling a night of pulls plus five reference parses takes minutes on a cold cache. */
export const maxDuration = 800;

interface AnalyzeBody {
  code?: string;
  actorId?: number;
  fightIds?: number[];
  referenceSize?: number;
}

/**
 * Streams progress as server-sent events. A cold eight-pull analysis makes well
 * over eighty upstream queries, so a plain request/response would leave the user
 * staring at a spinner with no idea whether anything is happening.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as AnalyzeBody;

  if (!body.code || body.actorId == null || !body.fightIds?.length) {
    return Response.json(
      { error: "code, actorId and a non-empty fightIds array are required" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const report = await analyzeEncounter({
          code: body.code!,
          actorId: body.actorId!,
          fightIds: body.fightIds!,
          referenceSize: body.referenceSize,
          onProgress: (message) => send("progress", { message }),
        });

        send("report", report);
      } catch (error) {
        send("error", { message: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
