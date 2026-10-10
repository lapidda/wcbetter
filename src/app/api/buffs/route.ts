import { analyzeBuffValue } from "@/lib/buff-value";

export const runtime = "nodejs";
/** Every damage event of every selected pull: a long night is a lot of pages. */
export const maxDuration = 800;

interface Body {
  code?: string;
  fightIds?: number[];
}

/** Streams progress as server-sent events, like /api/raid. */
export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  if (!body.code || !body.fightIds?.length) {
    return Response.json({ error: "code and a non-empty fightIds array are required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const result = await analyzeBuffValue({
          code: body.code!,
          fightIds: body.fightIds!,
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
