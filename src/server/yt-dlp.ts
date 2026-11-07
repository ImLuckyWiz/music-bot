import { getCookiesPath, getYtDlpBinaryPath } from "./paths";
import { pathExists } from "./downloads";

type TYtDlpMetadataResult = {
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
};

type TYtDlpTrackInfo = {
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  streamUrl?: string;
  httpHeaders?: Record<string, string>;
  webpageUrl?: string;
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
    title?: unknown;
    thumbnail?: unknown;
    duration?: unknown;
    url?: unknown;
    webpage_url?: unknown;
    http_headers?: unknown;
    entries?: Array<{
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

export {
  fetchYouTubeMetadata,
  isYouTubeUrl,
  logYtDlpLine,
  resolveYouTubeTrack,
  spawnYouTubeAudioPipe,
};
export type { TYtDlpMetadataResult, TYtDlpOptions, TYtDlpTrackInfo };
