import { crewRunner, type RunnerEvent } from '@/lib/crew-runner';
import {
  ErrorCodes,
  errorResponse,
  parseIdParam,
  requireCaller,
} from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';
import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/runs/[id]/stream' });

export const runtime = 'nodejs';

/** Terminal statuses that end the stream (no more events expected). */
const TERMINAL_STATUSES = new Set(['completed', 'errored', 'cancelled']);

const MAX_STREAMS_PER_USER = Math.max(
  1,
  Number(process.env.CREW_MAX_STREAMS_PER_USER) || 8
);
const activeStreamsByUser = new Map<string, number>();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await context.params;

  // Defensive content-negotiation: if the client sent an explicit Accept
  // header that doesn't allow text/event-stream, fail cleanly instead of
  // streaming bytes they can't parse. */* matches and is fine.
  const accept = request.headers.get('accept');
  if (accept && !accept.includes('*/*') && !accept.includes('text/event-stream')) {
    const response = errorResponse(
      406,
      ErrorCodes.NOT_ACCEPTABLE,
      'Accept header excludes text/event-stream'
    );
    response.headers.set('Vary', 'Accept');
    return response;
  }

  // Caller identity is set by middleware on every /api/* request via the
  // canonical requireCaller helper — keeps the envelope/code consistent
  // with every other route.
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  // UUID validation on the path param. Mirrors every other [id] route so
  // a malformed id is rejected before it reaches the runner.
  const idResult = parseIdParam(rawId);
  if (!idResult.ok) return idResult.response;
  const id = idResult.id;

  // Ownership-gated lookup. getRun() returns null both when the run
  // doesn't exist and when it exists but belongs to someone else —
  // collapse both to 404 so we never confirm a foreign run's existence.
  const run = crewRunner.getRun(id, caller.user);
  if (!run) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Run not found');
  }

  const userKey = caller.user;
  const currentCount = activeStreamsByUser.get(userKey) ?? 0;
  if (currentCount >= MAX_STREAMS_PER_USER) {
    return errorResponse(
      429,
      'TOO_MANY_REQUESTS',
      'Too many concurrent stream connections for this user'
    );
  }
  activeStreamsByUser.set(userKey, currentCount + 1);

  let slotReleased = false;
  function releaseSlot() {
    if (slotReleased) return;
    slotReleased = true;
    const next = (activeStreamsByUser.get(userKey) ?? 1) - 1;
    if (next <= 0) {
      activeStreamsByUser.delete(userKey);
    } else {
      activeStreamsByUser.set(userKey, next);
    }
  }

  const encoder = new TextEncoder();

  // Captured by start() and reused by cancel() so a client disconnect
  // (browser tab close, navigation away, network drop) tears down the
  // heartbeat timer and detaches the runner subscription. Without this
  // the listener stays bound to the per-run emitter forever.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  // Once the underlying ReadableStream controller is closed, every
  // subsequent enqueue() throws. Track it explicitly so we can short-
  // circuit safely instead of catching the same error per-event.
  let closed = false;
  // Monotonic SSE event id — lets clients use Last-Event-ID for
  // resume on reconnect (server-side handling is a future story; for
  // now the client falls back to a snapshot refetch).
  let nextEventId = 0;
  // Backpressure bookkeeping. When the consumer can't keep up we drop
  // events rather than buffering unbounded — the client will refetch the
  // snapshot on reconnect (Wave 2 behaviour). We log exactly once per
  // stream to avoid flooding when a slow consumer stays slow.
  let droppedCount = 0;
  let backpressureLogged = false;

  function teardown() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        function safeEnqueue(payload: string): void {
          if (closed) return;
          // Backpressure: if the internal queue is full, drop the event
          // silently. The client sees a gap and refetches the snapshot
          // on its next reconnect — acceptable degradation.
          if (
            controller.desiredSize !== null &&
            controller.desiredSize <= 0
          ) {
            droppedCount++;
            if (!backpressureLogged) {
              backpressureLogged = true;
              log.warn({ runId: id, dropped: droppedCount }, 'backpressure: dropping events');
            }
            return;
          }
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            // Controller is gone — most commonly the client disconnected
            // between the heartbeat tick and the enqueue. Mark closed so
            // we stop trying to push subsequent events.
            closed = true;
          }
        }

        function send(event: string, data: unknown): void {
          const eventId = nextEventId++;
          safeEnqueue(
            `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          );
        }

        // Tell the client to retry after 5s when our connection drops
        // (their default is 3s; we want a bit more breathing room). This
        // pairs with the client's exponential backoff cap.
        safeEnqueue(`retry: 5000\n\n`);

        const onAbort = () => {
          if (closed) return;
          closed = true;
          teardown();
          releaseSlot();
          try { controller.close(); } catch { /* already closed */ }
        };
        if (request.signal.aborted) { onAbort(); return; }
        request.signal.addEventListener('abort', onAbort, { once: true });

        // Initial snapshot so the client has full state even for completed runs
        send('snapshot', run);

        let terminalScheduled = false;

        // Stream new events. The per-run emitter means we never see
        // events for other runs, so no runId filter is needed here.
        // subscribe() can throw if the runner is in a bad state — if so,
        // tear down cleanly so heartbeat/listeners don't leak, then
        // re-throw to error the stream.
        try {
          unsubscribe = crewRunner.subscribe(id, (ev: RunnerEvent) => {
            send(ev.type, ev);
            if (
              ev.type === 'status' &&
              TERMINAL_STATUSES.has(ev.run.status)
            ) {
              if (terminalScheduled) return;
              terminalScheduled = true;
              // Give the client a chance to flush the status event before
              // we close, then send a definitive 'end' marker so the
              // client knows not to reconnect.
              setTimeout(() => {
                if (closed) return;
                send('end', { status: ev.run.status });
                teardown();
                releaseSlot();
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
                closed = true;
              }, 100);
            }
          });
        } catch (err) {
          // Leave unsubscribe as null — subscribe() didn't return a
          // detach function, so there's nothing to call. teardown()
          // will only clear the heartbeat (which hasn't started yet
          // at this point, but be defensive).
          teardown();
          releaseSlot();
          throw err;
        }

        // If run is already terminal, close immediately after snapshot.
        // Emit the 'end' marker first so the client doesn't try to
        // reconnect on a normal stream end.
        if (run.status !== 'running' && run.status !== 'queued') {
          if (terminalScheduled) return;
          terminalScheduled = true;
          setTimeout(() => {
            if (!closed) {
              send('end', { status: run.status });
            }
            teardown();
            releaseSlot();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            closed = true;
          }, 0);
          return;
        }

        // Heartbeat so proxies don't drop the connection. SSE comments
        // (lines starting with ":") are ignored by the client but keep
        // the socket warm.
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            closed = true;
          }
        }, 15000);
      },
      cancel() {
        // Fired when the client disconnects before the run terminates.
        closed = true;
        teardown();
        releaseSlot();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 256_000 })
  );

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Content-Encoding': 'identity',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      Vary: 'Accept',
    },
  });
}
