import { lookupTopTank } from "@/lib/tank-lookup";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Body {
  encounterID?: number;
  difficulty?: number;
  className?: string;
  specName?: string;
  pick?: number;
}

/** Streams progress as server-sent events, like /api/raid: a cold log takes a while. */
export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  if (!body.encounterID || !body.difficulty || !body.className || !body.specName) {
    return Response.json({ error: "encounterID, difficulty, className and specName are required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const result = await lookupTopTank({
          encounterID: body.encounterID!,
          difficulty: body.difficulty!,
          className: body.className!,
          specName: body.specName!,
          pick: body.pick,
          onProgress: (message) => send("progress", { message }),
        });
        send("report", result);
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
