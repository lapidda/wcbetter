import { analyzeRaidEncounter, toRaidPayload } from "@/lib/raid";

export const runtime = "nodejs";
/** A cold night of pulls is dozens of paginated event queries. */
export const maxDuration = 800;

interface RaidBody {
  code?: string;
  fightIds?: number[];
}

/**
 * Streams the raid-wide failure analysis as server-sent events.
 *
 * A separate route from `/api/analyze` rather than a mode flag on it: this pass
 * has no subject player, no rankings and no reference profiles, so sharing an
 * entry point would mean a nullable `actorId` weakening that route's validation,
 * and a union return type infecting every consumer of `AnalysisReport`.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as RaidBody;

  if (!body.code || !body.fightIds?.length) {
    return Response.json({ error: "code and a non-empty fightIds array are required" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const report = await analyzeRaidEncounter({
          code: body.code!,
          fightIds: body.fightIds!,
          onProgress: (message) => send("progress", { message }),
        });
        // Trimmed: the raw occurrence lists never leave the server.
        send("report", toRaidPayload(report));
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
