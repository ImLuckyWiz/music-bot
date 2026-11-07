import { getCookiesPath, getYtDlpBinaryPath } from "./paths";
import { pathExists } from "./downloads";

type TYtDlpMetadataResult = {
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
};

type TVideoCodec = "h264" | "vp9" | "unsupported";

type TYtDlpTrackInfo = {
  id?: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  /** audio-capable direct URL, used by the audio-only pipeline */
  streamUrl?: string;
  httpHeaders?: Record<string, string>;
  webpageUrl?: string;
  /** video and audio inputs; identical when the source is a single muxed file */
  videoStreamUrl?: string;
  audioStreamUrl?: string;
  videoCodec?: TVideoCodec;
  videoWidth?: number;
  videoHeight?: number;
  /** yt-dlp format id and protocol of the video, for diagnostics */
  videoFormatId?: string;
  videoProtocol?: string;
  /** true only when a supported video codec and both stream URLs are present */
  hasVideo: boolean;
  /** the max height this track was resolved for, 0 meaning audio only */
  resolvedMaxHeight: number;
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
  /** when set, resolve a video + audio pair up to this height instead of audio only */
  maxHeight?: number;
  /** prefer 30fps or lower video, which needs far less bandwidth */
  limitFps?: boolean;
};

const AUDIO_FORMAT_SELECTOR = "bestaudio[ext=webm]/bestaudio/best";

/**
 * VP9 first at every resolution. YouTube's H.264 uses B-frames, and forwarding
 * those untouched makes RTP timestamps jump backwards (decode order vs display
 * order), which WebRTC receivers render as stutter. VP9 has no such reordering,
 * so it can be copied as-is; H.264 is only the fallback and gets re-encoded
 * without B-frames (see ffmpeg.ts).
 * Video is forwarded untouched, so a 60fps source costs roughly double the
 * bitrate and packet rate: with limitFps, 30fps (or lower) variants are tried
 * first and 60fps is only the fallback.
 */
const buildVideoFormatSelector = (
  maxHeight: number,
  limitFps: boolean,
): string => {
  // protocol=https only: YouTube also lists HLS (m3u8) copies of the same
  // codecs, and FFmpeg's HLS demuxer fetches segments on its own, bypassing the
  // chunk proxy and starting video seconds after the audio
  const variant = (codec: string, fps: boolean) =>
    `bestvideo[protocol=https][vcodec^=${codec}][height<=${maxHeight}]${fps ? "[fps<=30]" : ""}+bestaudio[protocol=https]`;
  // some formats report the short name "vp9" instead of "vp09.xx"
  const codecs = ["vp09", "vp9", "avc1"];
  const fpsPasses = limitFps ? [true, false] : [false];
  const video = fpsPasses.flatMap((fps) =>
    codecs.map((codec) => variant(codec, fps)),
  );

  return [...video, `best[height<=${maxHeight}]`, "best"].join("/");
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

type TRawFormat = {
  url?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  width?: unknown;
  height?: unknown;
  http_headers?: unknown;
  format_id?: unknown;
  protocol?: unknown;
};

const hasCodec = (codec: unknown): boolean =>
  typeof codec === "string" && codec !== "" && codec !== "none";

const detectVideoCodec = (vcodec: unknown): TVideoCodec => {
  if (typeof vcodec !== "string") return "unsupported";

  const codec = vcodec.toLowerCase();

  if (codec.startsWith("avc1")) return "h264";
  if (codec.startsWith("vp09") || codec.startsWith("vp9")) return "vp9";

  return "unsupported";
};

const getHttpUrl = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().startsWith("http")
    ? value.trim()
    : undefined;

const toPositiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

const parseYtDlpTrackInfo = (
  stdout: string,
  sourceUrl: string,
  maxHeight = 0,
): TYtDlpTrackInfo => {
  const jsonText = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!jsonText) {
    return { title: sourceUrl, hasVideo: false, resolvedMaxHeight: maxHeight };
  }

  type TMetadata = TRawFormat & {
    id?: unknown;
    title?: unknown;
    thumbnail?: unknown;
    duration?: unknown;
    webpage_url?: unknown;
    requested_formats?: TRawFormat[];
  };

  const parsed = JSON.parse(jsonText) as TMetadata & {
    entries?: TMetadata[];
  };

  const metadata: TMetadata = Array.isArray(parsed.entries)
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

  const webpageUrl =
    typeof metadata.webpage_url === "string" && metadata.webpage_url.trim()
      ? metadata.webpage_url.trim()
      : undefined;

  // a merged selector (video+audio) reports its parts in requested_formats;
  // a single format reports itself at the top level
  const formats: TRawFormat[] =
    Array.isArray(metadata.requested_formats) &&
    metadata.requested_formats.length > 0
      ? metadata.requested_formats
      : [metadata];

  const videoFormat = formats.find((format) => hasCodec(format.vcodec));
  const audioOnlyFormat = formats.find(
    (format) => hasCodec(format.acodec) && !hasCodec(format.vcodec),
  );

  const videoUrl = getHttpUrl(videoFormat?.url);
  const muxedAudio = videoFormat && hasCodec(videoFormat.acodec);
  const audioUrl = getHttpUrl(audioOnlyFormat?.url) ?? (muxedAudio ? videoUrl : undefined);

  const streamUrl =
    getHttpUrl(metadata.url) ??
    getHttpUrl(audioOnlyFormat?.url) ??
    audioUrl;

  const videoCodec = videoFormat ? detectVideoCodec(videoFormat.vcodec) : undefined;
  const wantsVideo = maxHeight > 0;
  const hasVideo =
    wantsVideo &&
    !!videoUrl &&
    !!audioUrl &&
    !!videoCodec &&
    videoCodec !== "unsupported";

  const headerSource = (videoFormat?.http_headers ?? metadata.http_headers) as unknown;
  const httpHeaders =
    headerSource && typeof headerSource === "object"
      ? (headerSource as Record<string, string>)
      : undefined;

  return {
    id,
    title,
    thumbnailUrl,
    durationSeconds,
    streamUrl,
    webpageUrl,
    httpHeaders,
    videoStreamUrl: wantsVideo ? videoUrl : undefined,
    audioStreamUrl: wantsVideo ? audioUrl : undefined,
    videoCodec: wantsVideo ? videoCodec : undefined,
    videoWidth: wantsVideo ? toPositiveInt(videoFormat?.width) : undefined,
    videoHeight: wantsVideo ? toPositiveInt(videoFormat?.height) : undefined,
    videoFormatId: wantsVideo && videoFormat?.format_id != null ? String(videoFormat.format_id) : undefined,
    videoProtocol: wantsVideo && typeof videoFormat?.protocol === "string" ? videoFormat.protocol : undefined,
    hasVideo,
    resolvedMaxHeight: maxHeight,
  };
};

const resolveYouTubeTrack = async (
  sourceUrl: string,
  options: TYtDlpOptions,
): Promise<TYtDlpTrackInfo> => {
  const ytDlpPath = getYtDlpBinaryPath();
  const base = await getYtDlpBaseArgs(options);
  const maxHeight = options.maxHeight && options.maxHeight > 0 ? options.maxHeight : 0;
  const cmd = [
    ytDlpPath,
    ...base,
    "-f",
    maxHeight > 0 ? buildVideoFormatSelector(maxHeight, options.limitFps ?? false) : AUDIO_FORMAT_SELECTOR,
    "--dump-single-json",
    "--skip-download",
    sourceUrl,
  ];

  options.log(
    "Resolving YouTube track via yt-dlp:",
    sourceUrl,
    maxHeight > 0 ? `(video up to ${maxHeight}p)` : "(audio only)",
  );

  const res = await runYtDlp(cmd, "track resolution", options);

  if (res.exitCode !== 0) {
    throw new Error(`yt-dlp track resolution failed (exit ${res.exitCode})`);
  }

  const track = parseYtDlpTrackInfo(res.stdout, sourceUrl, maxHeight);

  if (maxHeight > 0) {
    options.log(
      track.hasVideo
        ? `Resolved ${track.videoCodec} video ${track.videoWidth ?? "?"}x${track.videoHeight ?? "?"} (format ${track.videoFormatId ?? "?"}, ${track.videoProtocol ?? "?"})`
        : `No streamable video (codec: ${track.videoCodec ?? "none"}); audio only`,
    );
  }

  return track;
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
    AUDIO_FORMAT_SELECTOR,
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
  TVideoCodec,
  TRelatedTrack,
  TYtDlpMetadataResult,
  TYtDlpOptions,
  TYtDlpTrackInfo,
};
