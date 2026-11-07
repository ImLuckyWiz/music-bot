import { getCookiesPath, getYtDlpBinaryPath } from "./paths";
import { pathExists } from "./downloads";

type TYtDlpMetadataResult = {
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
};

type TYtDlpTrackInfo = {
  id?: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  streamUrl?: string;
  httpHeaders?: Record<string, string>;
  webpageUrl?: string;
};

type TRelatedTrack = {
  id: string;
  title: string;
  url: string;
};

type TYtDlpOptions = {
  log: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
  proxy?: string;
};

const YT_DLP_COMMAND_TIMEOUT_MS = 25000;
const YT_DLP_HEARTBEAT_MS = 5000;
const YT_DLP_SOCKET_TIMEOUT_SECONDS = 15;
const YT_DLP_FORCE_KILL_TIMEOUT_MS = 1500;

const terminateYtDlp = (process: ReturnType<typeof Bun.spawn>): void => {
  try {
    process.kill("SIGTERM");
  } catch {}

  setTimeout(() => {
    try {
      process.kill("SIGKILL");
    } catch {}
  }, YT_DLP_FORCE_KILL_TIMEOUT_MS);
};

const logYtDlpLine = (line: string, options: TYtDlpOptions): void => {
  if (line.startsWith("ERROR:")) {
    options.error("[yt-dlp]", line);

    return;
  }

  if (line.startsWith("WARNING:")) {
    options.log("[yt-dlp]", line);

    return;
  }

  options.debug("[yt-dlp]", line);
};

/** progress rewrites the line with \r, so both terminators split output */
const logYtDlpOutput = (text: string, options: TYtDlpOptions): void => {
  for (const line of text.split(/\r\n|[\n\r]/)) {
    const trimmedLine = line.trim();

    if (trimmedLine) logYtDlpLine(trimmedLine, options);
  }
};

const isYouTubeUrl = (url: string): boolean =>
  url.includes("youtube.com") ||
  url.includes("youtu.be") ||
  url.startsWith("ytsearch:");

const getYtDlpBaseArgs = async (options: TYtDlpOptions): Promise<string[]> => {
  const cookiesPath = getCookiesPath();
  const cookiesArgs = (await pathExists(cookiesPath))
    ? ["--cookies", cookiesPath]
    : [];
  const proxyArgs = options.proxy ? ["--proxy", options.proxy] : [];

  const baseArgs = [
    "--js-runtimes",
    "bun",
    "--no-warnings",
    "--no-playlist",
    "--socket-timeout",
    String(YT_DLP_SOCKET_TIMEOUT_SECONDS),
    ...cookiesArgs,
    ...proxyArgs,
  ];

  options.log(`Yt-dlp base arguments:`, baseArgs.join(" "));

  return baseArgs;
};

const runYtDlp = async (
  cmd: string[],
  label: string,
  options: TYtDlpOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  options.log(`[yt-dlp] starting ${label}`);

  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const startedAt = Date.now();
  const heartbeatId = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);

    options.log(`[yt-dlp] still running (${label}) after ${elapsedSeconds}s`);
  }, YT_DLP_HEARTBEAT_MS);

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      options.error(
        `[yt-dlp] ${label} timed out after ${YT_DLP_COMMAND_TIMEOUT_MS}ms`,
      );

      terminateYtDlp(proc);

      reject(
        new Error(
          `yt-dlp ${label} timed out after ${YT_DLP_COMMAND_TIMEOUT_MS}ms`,
        ),
      );
    }, YT_DLP_COMMAND_TIMEOUT_MS);
  });

  const commandPromise = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));

  try {
    const { stdout, stderr, exitCode } = await Promise.race([
      commandPromise,
      timeoutPromise,
    ]);

    logYtDlpOutput(stderr, options);

    options.log(`[yt-dlp] ${label} finished with exit code ${exitCode}`);

    return { stdout, stderr, exitCode };
  } finally {
    clearInterval(heartbeatId);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const parseYtDlpTrackInfo = (
  stdout: string,
  sourceUrl: string,
): TYtDlpTrackInfo => {
  const jsonText = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!jsonText) {
    return { title: sourceUrl };
  }

  const parsed = JSON.parse(jsonText) as {
    id?: unknown;
    title?: unknown;
    thumbnail?: unknown;
    duration?: unknown;
    url?: unknown;
    webpage_url?: unknown;
    http_headers?: unknown;
    entries?: Array<{
      id?: unknown;
      title?: unknown;
      thumbnail?: unknown;
      duration?: unknown;
      url?: unknown;
      webpage_url?: unknown;
      http_headers?: unknown;
    }>;
  };

  const metadata = Array.isArray(parsed.entries)
    ? (parsed.entries.find(Boolean) ?? parsed)
    : parsed;

  const id =
    typeof metadata.id === "string" && metadata.id.trim()
      ? metadata.id.trim()
      : extractYouTubeVideoId(sourceUrl) ?? undefined;

  const title =
    typeof metadata.title === "string" && metadata.title.trim()
      ? metadata.title.trim()
      : sourceUrl;

  const thumbnailUrl =
    typeof metadata.thumbnail === "string" && metadata.thumbnail.trim()
      ? metadata.thumbnail.trim()
      : undefined;

  const durationSeconds =
    typeof metadata.duration === "number" && Number.isFinite(metadata.duration)
      ? Math.max(0, Math.floor(metadata.duration))
      : undefined;

  const streamUrl =
    typeof metadata.url === "string" && metadata.url.trim().startsWith("http")
      ? metadata.url.trim()
      : undefined;

  const webpageUrl =
    typeof metadata.webpage_url === "string" && metadata.webpage_url.trim()
      ? metadata.webpage_url.trim()
      : undefined;

  const httpHeaders =
    metadata.http_headers && typeof metadata.http_headers === "object"
      ? (metadata.http_headers as Record<string, string>)
      : undefined;

  return {
    id,
    title,
    thumbnailUrl,
    durationSeconds,
    streamUrl,
    webpageUrl,
    httpHeaders,
  };
};

const resolveYouTubeTrack = async (
  sourceUrl: string,
  options: TYtDlpOptions,
): Promise<TYtDlpTrackInfo> => {
  const ytDlpPath = getYtDlpBinaryPath();
  const base = await getYtDlpBaseArgs(options);
  const cmd = [
    ytDlpPath,
    ...base,
    "-f",
    "bestaudio[ext=webm]/bestaudio/best",
    "--dump-single-json",
    "--skip-download",
    sourceUrl,
  ];

  options.log("Resolving YouTube track via yt-dlp:", sourceUrl);

  const res = await runYtDlp(cmd, "track resolution", options);

  if (res.exitCode !== 0) {
    throw new Error(`yt-dlp track resolution failed (exit ${res.exitCode})`);
  }

  return parseYtDlpTrackInfo(res.stdout, sourceUrl);
};

const fetchYouTubeMetadata = async (
  sourceUrl: string,
  options: TYtDlpOptions,
): Promise<TYtDlpMetadataResult> => {
  const track = await resolveYouTubeTrack(sourceUrl, options);

  return {
    title: track.title,
    thumbnailUrl: track.thumbnailUrl,
    durationSeconds: track.durationSeconds,
  };
};

const spawnYouTubeAudioPipe = async (
  sourceUrl: string,
  options: TYtDlpOptions,
): Promise<ReturnType<typeof Bun.spawn>> => {
  const ytDlpPath = getYtDlpBinaryPath();
  const base = await getYtDlpBaseArgs(options);

  const cmd = [
    ytDlpPath,
    ...base,
    "-f",
    "bestaudio[ext=webm]/bestaudio/best",
    "-o",
    "-",
    sourceUrl,
  ];

  options.log("Starting yt-dlp streaming pipe:", cmd.join(" "));

  return Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
};

const extractYouTubeVideoId = (url: string): string | null => {
  const match = url.match(
    /(?:v=|youtu\.be\/|embed\/|shorts\/|watch\?.*v=)([a-zA-Z0-9_-]{11})/,
  );
  return match ? match[1] ?? null : null;
};

const fetchYouTubeRelatedTracks = async (
  seedUrlOrId: string,
  options: TYtDlpOptions,
  seedTitle?: string,
): Promise<TRelatedTrack[]> => {
  const videoId = extractYouTubeVideoId(seedUrlOrId) ?? seedUrlOrId;
  const isId = /^[a-zA-Z0-9_-]{11}$/.test(videoId);

  const ytDlpPath = getYtDlpBinaryPath();
  const rawBase = await getYtDlpBaseArgs(options);
  // Filter out --no-playlist so yt-dlp can retrieve YouTube Mix (Radio) playlists
  const base = rawBase.filter((arg) => arg !== "--no-playlist");

  // 1. Try YouTube Mix/Radio playlist if we have a valid 11-char videoId
  if (isId) {
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    options.log(`[yt-dlp] Fetching YouTube Mix recommendations for ${videoId}`);

    try {
      const cmd = [
        ytDlpPath,
        ...base,
        "--yes-playlist",
        "--flat-playlist",
        "--dump-json",
        "--playlist-items",
        "1-25",
        mixUrl,
      ];
      const res = await runYtDlp(cmd, "fetch related mix", options);
      if (res.exitCode === 0 && res.stdout.trim()) {
        const tracks: TRelatedTrack[] = [];
        for (const line of res.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as {
              id?: string;
              title?: string;
              url?: string;
              duration?: number;
            };
            if (entry.id && entry.id !== videoId) {
              // Ignore short meme clips or sound effects under 60 seconds
              if (typeof entry.duration === "number" && entry.duration < 60) {
                continue;
              }
              tracks.push({
                id: entry.id,
                title: entry.title ?? `Recommended Track (${entry.id})`,
                url: `https://www.youtube.com/watch?v=${entry.id}`,
              });
            }
          } catch {}
        }
        if (tracks.length > 0) {
          options.log(`[yt-dlp] Found ${tracks.length} mix recommendations`);
          return tracks;
        }
      }
    } catch (err) {
      options.error("[yt-dlp] Failed to fetch mix recommendations:", err);
    }
  }

  // 2. Fallback: Search related songs using ytsearch
  // Avoid querying raw 11-character hash IDs on search as it produces unrelated clips.
  const cleanTitle = (seedTitle ?? "").replace(/[^\w\s]/gi, " ").trim();
  const queryTerm =
    cleanTitle.length > 2 ? cleanTitle : isId ? "" : seedUrlOrId;

  if (queryTerm) {
    const searchQuery = `ytsearch10:${queryTerm} music`;
    options.log(`[yt-dlp] Fallback search for related tracks: ${searchQuery}`);
    try {
      const cmd = [
        ytDlpPath,
        ...base,
        "--flat-playlist",
        "--dump-json",
        searchQuery,
      ];
      const res = await runYtDlp(cmd, "search related fallback", options);
      if (res.exitCode === 0 && res.stdout.trim()) {
        const tracks: TRelatedTrack[] = [];
        for (const line of res.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as {
              id?: string;
              title?: string;
              url?: string;
              duration?: number;
            };
            if (entry.id && entry.id !== videoId) {
              if (typeof entry.duration === "number" && entry.duration < 60) {
                continue;
              }
              tracks.push({
                id: entry.id,
                title: entry.title ?? `Track ${entry.id}`,
                url: `https://www.youtube.com/watch?v=${entry.id}`,
              });
            }
          } catch {}
        }
        if (tracks.length > 0) {
          return tracks;
        }
      }
    } catch (err) {
      options.error("[yt-dlp] Fallback related search failed:", err);
    }
  }

  return [];
};

export {
  extractYouTubeVideoId,
  fetchYouTubeMetadata,
  fetchYouTubeRelatedTracks,
  isYouTubeUrl,
  logYtDlpLine,
  resolveYouTubeTrack,
  spawnYouTubeAudioPipe,
};
export type {
  TRelatedTrack,
  TYtDlpMetadataResult,
  TYtDlpOptions,
  TYtDlpTrackInfo,
};
