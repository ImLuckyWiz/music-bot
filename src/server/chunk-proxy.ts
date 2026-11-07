/**
 * A local HTTP proxy that gives FFmpeg a steady, Range-aware source on
 * 127.0.0.1 while it fetches the real media from googlevideo the way yt-dlp's
 * downloader does: many short ranged requests, a bounded read-ahead, and
 * retries that resume from the last byte received.
 */

type TProxyLogger = {
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
};

type TProxySessionOptions = TProxyLogger & {
  upstreamUrl: string;
  /** http_headers from yt-dlp, sent on every upstream request */
  headers?: Record<string, string>;
  proxy?: string;
  /** shows up in the logs, e.g. "video" or "audio" */
  label: string;
  /** called when the upstream URL expires; return a fresh one or null to give up */
  refreshUrl?: () => Promise<string | null>;
};

type TProxySessionHandle = {
  /** the URL FFmpeg should read from */
  url: string;
  close: () => void;
};

type TRangeMode = "header" | "param";

type TProxySession = {
  token: string;
  label: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  proxy?: string;
  totalBytes: number;
  mimeType: string;
  rangeMode: TRangeMode;
  refreshes: number;
  refreshUrl?: () => Promise<string | null>;
  abort: AbortController;
  logger: TProxyLogger;
  stats: { bytes: number; chunks: number; retries: number };
};

class UpstreamExpiredError extends Error {
  constructor(status: number) {
    super(`upstream URL rejected (HTTP ${status})`);
    this.name = "UpstreamExpiredError";
  }
}

// googlevideo throttles each ranged request to about playback speed, so a big
// chunk takes long to arrive in full: use small ones and several in flight
const CHUNK_BYTES = 2 * 1024 * 1024;
const FIRST_CHUNK_BYTES = 1024 * 1024; // small, so playback starts quickly
const READ_AHEAD_CHUNKS = 3; // held chunks = the one being served + this many
const SLICE_BYTES = 256 * 1024;
const OUT_QUEUE_BYTES = 1024 * 1024; // what may sit unread in the response
const STALL_TIMEOUT_MS = 10_000; // no bytes for this long fails the attempt
const PROBE_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const MAX_URL_REFRESHES = 2;
const BACKOFF_MS = [250, 500, 1000, 2000];

const sessions = new Map<string, TProxySession>();
let server: ReturnType<typeof Bun.serve> | null = null;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildUpstreamRequest = (
  session: TProxySession,
  start: number,
  end: number,
): { url: string; headers: Record<string, string> } => {
  const url = new URL(session.upstreamUrl);
  const headers = { ...session.headers };

  if (session.rangeMode === "param") {
    url.searchParams.set("range", `${start}-${end}`);
  } else {
    headers["Range"] = `bytes=${start}-${end}`;
  }

  return { url: url.toString(), headers };
};

const upstreamFetch = (
  session: TProxySession,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Response> => {
  const request = buildUpstreamRequest(session, start, end);

  return fetch(request.url, {
    headers: request.headers,
    signal,
    // Bun extension: route through the plugin's Proxy URL setting
    ...(session.proxy ? { proxy: session.proxy } : {}),
  } as RequestInit);
};

/**
 * Fetches bytes start..end into memory. A failed attempt resumes from the last
 * byte received, and only attempts that make no progress count against the cap.
 */
const fetchChunk = async (
  session: TProxySession,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const length = end - start + 1;
  const out = new Uint8Array(length);
  let received = 0;
  let failedAttempts = 0;

  while (received < length) {
    if (signal.aborted) throw new Error("aborted");

    const attempt = new AbortController();
    const forwardAbort = () => attempt.abort();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);

      stallTimer = setTimeout(() => attempt.abort(), STALL_TIMEOUT_MS);
    };
    const receivedBefore = received;

    signal.addEventListener("abort", forwardAbort, { once: true });

    try {
      armStallTimer();

      const response = await upstreamFetch(
        session,
        start + received,
        end,
        attempt.signal,
      );

      if (response.status === 403 || response.status === 410) {
        throw new UpstreamExpiredError(response.status);
      }

      // a 200 to a ranged request past byte 0 means the Range header was
      // ignored; the range query parameter is the other way YouTube takes it
      if (
        response.status === 200 &&
        start + received > 0 &&
        session.rangeMode === "header"
      ) {
        void response.body?.cancel();
        session.rangeMode = "param";
        session.logger.log(
          `[chunk-proxy] ${session.label}: Range header ignored, using the range parameter`,
        );
        continue;
      }

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();

      try {
        while (received < length) {
          const { done, value } = await reader.read();

          if (done) break;

          armStallTimer();

          const room = length - received;
          const piece = value.length > room ? value.subarray(0, room) : value;

          out.set(piece, received);
          received += piece.length;
        }
      } finally {
        void reader.cancel().catch(() => {});
      }

      if (received < length) {
        throw new Error(`connection closed early (${received}/${length} bytes)`);
      }
    } catch (err) {
      if (signal.aborted) throw err;

      if (err instanceof UpstreamExpiredError) {
        const fresh =
          session.refreshUrl && session.refreshes < MAX_URL_REFRESHES
            ? await session.refreshUrl().catch(() => null)
            : null;

        if (!fresh) throw err;

        session.refreshes++;
        session.upstreamUrl = fresh;
        session.logger.log(
          `[chunk-proxy] ${session.label}: upstream URL expired, refreshed (${session.refreshes}/${MAX_URL_REFRESHES})`,
        );
        continue;
      }

      failedAttempts = received > receivedBefore ? 1 : failedAttempts + 1;
      session.stats.retries++;

      const reason = err instanceof Error ? err.message : String(err);

      if (failedAttempts >= MAX_ATTEMPTS) {
        session.logger.error(
          `[chunk-proxy] ${session.label}: giving up at byte ${start + received}: ${reason}`,
        );

        throw err;
      }

      session.logger.log(
        `[chunk-proxy] ${session.label}: retry ${failedAttempts}/${MAX_ATTEMPTS - 1} resuming at byte ${start + received}: ${reason}`,
      );

      await sleep(BACKOFF_MS[Math.min(failedAttempts - 1, BACKOFF_MS.length - 1)]!);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);

      signal.removeEventListener("abort", forwardAbort);
    }
  }

  session.stats.chunks++;
  session.stats.bytes += length;

  return out;
};

type TQueuedChunk = { promise: Promise<Uint8Array> };

/**
 * Serves bytes start..end as a stream. Chunks are fetched ahead of the reader
 * but only up to a bound, and slices are handed over only as fast as the
 * reader (FFmpeg, paced by -re) takes them.
 */
const createRangeBody = (
  session: TProxySession,
  start: number,
  end: number,
): ReadableStream<Uint8Array> => {
  const requestAbort = new AbortController();
  const signal = AbortSignal.any([session.abort.signal, requestAbort.signal]);
  const queue: TQueuedChunk[] = [];
  let current: { data: Uint8Array; offset: number } | null = null;
  let planCursor = start;

  const fill = () => {
    while (
      queue.length + (current ? 1 : 0) < 1 + READ_AHEAD_CHUNKS &&
      planCursor <= end
    ) {
      const size = planCursor === start ? FIRST_CHUNK_BYTES : CHUNK_BYTES;
      const chunkEnd = Math.min(planCursor + size - 1, end);
      const promise = fetchChunk(session, planCursor, chunkEnd, signal);

      // the error is surfaced when the chunk is awaited; this only keeps a
      // chunk that is never reached from becoming an unhandled rejection
      promise.catch(() => {});
      queue.push({ promise });
      planCursor = chunkEnd + 1;
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (!current) {
            fill();

            const head = queue.shift();

            if (!head) {
              controller.close();

              return;
            }

            current = { data: await head.promise, offset: 0 };
            fill();
          }

          const next = Math.min(current.offset + SLICE_BYTES, current.data.length);

          controller.enqueue(current.data.subarray(current.offset, next));
          current.offset = next;

          if (current.offset >= current.data.length) current = null;
        } catch (err) {
          requestAbort.abort();
          controller.error(err);
        }
      },
      cancel() {
        requestAbort.abort();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: OUT_QUEUE_BYTES }),
  );
};

/** "bytes=S-E", "bytes=S-" and "bytes=-N"; anything else (multi-range) is ignored */
const parseRange = (
  header: string | null,
  total: number,
): { start: number; end: number } | "invalid" | null => {
  if (!header) return null;

  const match = header.match(/^bytes=(\d*)-(\d*)$/);

  if (!match) return null;

  const [, rawStart = "", rawEnd = ""] = match;

  if (rawStart === "" && rawEnd === "") return "invalid";

  if (rawStart === "") {
    const suffix = Number(rawEnd);

    if (suffix <= 0) return "invalid";

    return { start: Math.max(0, total - suffix), end: total - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);

  if (start >= total || end < start) return "invalid";

  return { start, end };
};

const handleRequest = (request: Request): Response => {
  const token = new URL(request.url).pathname.slice(1);
  const session = sessions.get(token);

  if (!session) return new Response("Not found", { status: 404 });

  const total = session.totalBytes;
  const range = parseRange(request.headers.get("range"), total);

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": session.mimeType,
    "Content-Length": String(end - start + 1),
  };

  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;

  const status = range ? 206 : 200;

  if (request.method === "HEAD") return new Response(null, { status, headers });

  return new Response(createRangeBody(session, start, end), { status, headers });
};

const ensureServer = (): ReturnType<typeof Bun.serve> => {
  if (server) return server;

  server = Bun.serve({
    // loopback only: nothing outside this machine can reach the proxy
    hostname: "127.0.0.1",
    port: 0,
    // FFmpeg is paced to real time, so a response can sit idle between reads
    idleTimeout: 255,
    fetch: handleRequest,
  });

  return server;
};

const stopServerIfIdle = (): void => {
  if (sessions.size > 0 || !server) return;

  try {
    server.stop(true);
  } catch {}

  server = null;
};

/** learns the size and type with a one-byte ranged request */
const probeUpstream = async (
  session: TProxySession,
  upstreamUrl: string,
): Promise<void> => {
  const response = await upstreamFetch(
    session,
    0,
    0,
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
  );

  if (response.status === 403 || response.status === 410) {
    void response.body?.cancel();
    throw new UpstreamExpiredError(response.status);
  }

  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`probe failed (HTTP ${response.status})`);
  }

  const contentRangeTotal = Number(
    response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1],
  );
  const contentLength = Number(response.headers.get("content-length"));
  const clen = Number(new URL(upstreamUrl).searchParams.get("clen"));

  session.mimeType =
    response.headers.get("content-type") ?? "application/octet-stream";

  void response.body?.cancel();

  const total =
    (Number.isFinite(contentRangeTotal) && contentRangeTotal > 0
      ? contentRangeTotal
      : null) ??
    (response.status === 200 && contentLength > 1 ? contentLength : null) ??
    (Number.isFinite(clen) && clen > 0 ? clen : null);

  if (!total) throw new Error("could not determine the media size");

  session.totalBytes = total;
};

const createProxySession = async (
  options: TProxySessionOptions,
): Promise<TProxySessionHandle> => {
  const token = crypto.randomUUID();
  const logger: TProxyLogger = {
    log: options.log,
    error: options.error,
    debug: options.debug,
  };

  const session: TProxySession = {
    token,
    label: options.label,
    upstreamUrl: options.upstreamUrl,
    headers: { ...(options.headers ?? {}) },
    proxy: options.proxy || undefined,
    totalBytes: 0,
    mimeType: "application/octet-stream",
    rangeMode: "header",
    refreshes: 0,
    refreshUrl: options.refreshUrl,
    abort: new AbortController(),
    logger,
    stats: { bytes: 0, chunks: 0, retries: 0 },
  };

  await probeUpstream(session, options.upstreamUrl);

  sessions.set(token, session);

  const httpServer = ensureServer();
  let closed = false;

  options.log(
    `[chunk-proxy] ${options.label}: serving ${(session.totalBytes / 1024 / 1024).toFixed(1)} MB (${session.mimeType}) on port ${httpServer.port}`,
  );

  return {
    url: `http://127.0.0.1:${httpServer.port}/${token}`,
    close: () => {
      if (closed) return;

      closed = true;
      session.abort.abort();
      sessions.delete(token);

      options.log(
        `[chunk-proxy] ${options.label}: closed after ${(session.stats.bytes / 1024 / 1024).toFixed(1)} MB in ${session.stats.chunks} chunks, ${session.stats.retries} retries`,
      );

      stopServerIfIdle();
    },
  };
};

const stopChunkProxy = (): void => {
  for (const session of sessions.values()) session.abort.abort();

  sessions.clear();
  stopServerIfIdle();
};

export { createProxySession, stopChunkProxy };
export type { TProxySessionHandle, TProxySessionOptions };
