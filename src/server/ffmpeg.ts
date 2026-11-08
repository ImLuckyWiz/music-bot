import { createProxySession, type TProxySessionHandle } from "./chunk-proxy";
import { getFfmpegBinaryPath } from "./paths";
import { getAvailablePort } from "./volume-control";
import {
  isYouTubeUrl,
  logYtDlpLine,
  resolveYouTubeTrack,
  spawnYouTubeAudioPipe,
  type TYtDlpTrackInfo,
} from "./yt-dlp";

type TSpawnedStreamProcess = {
  ffmpeg: ReturnType<typeof Bun.spawn>;
  ytDlp: ReturnType<typeof Bun.spawn> | null;
  /** local chunk proxy sessions feeding ffmpeg, closed with it */
  inputSessions: TProxySessionHandle[];
};

type TMusicStreamResult = {
  process: TSpawnedStreamProcess;
  controlPort?: number;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  id?: string;
  /** true when this stream also carries video RTP */
  hasVideo: boolean;
};

type TMusicOptions = {
  sourceUrl: string;
  audioPayloadType: number;
  audioSsrc: number;
  rtpHost: string;
  audioRtpPort: number;
  /** set only when a video transport exists; the track must also carry video */
  videoPayloadType?: number;
  videoSsrc?: number;
  videoRtpPort?: number;

  /** needed to re-resolve a track whose URL expired mid-stream */
  limitFps?: boolean;
  /** the height the track was resolved for; sizes the H.264 re-encode bitrate */
  videoMaxHeight?: number;
  volume?: number; // 0-100, default 100
  bitrate?: string;
  proxy?: string;
  preResolvedTrack?: TYtDlpTrackInfo;
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
  onEnd?: () => void;
};

const FORCE_KILL_TIMEOUT_MS = 1500;

// a keyframe goes out as dozens of packets at once, so ask for a 1 MB send
// buffer (the kernel still caps it at net.core.wmem_max)
const RTP_OUTPUT_QUERY = "pkt_size=1200&buffer_size=1048576";

// no initial burst: FFmpeg forwards RTP as soon as it reads, so a burst dumps
// a second of video on the network at once and risks losing packets of the
// frames right after the first keyframe, which stalls the picture until the
// next keyframe. The chunk proxy already keeps the input buffered.
const INPUT_INITIAL_BURST_SECONDS = 0;

// H.264 from YouTube has B-frames, so copying it sends RTP timestamps backwards
// and the browser stutters. Re-encoding without B-frames keeps them monotonic.
const H264_TRANSCODE_BITRATES: Record<number, string> = {
  480: "1200k",
  720: "2500k",
  1080: "4500k",
  1440: "8000k",
};

const readLines = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let reads = 0;

  const flush = (text: string) => {
    const trimmedLine = text.trim();

    if (trimmedLine) onLine(trimmedLine);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // progress rewrites the line with \r, so both terminators end a line
      const lines = buffer.split(/\r\n|[\n\r]/);

      buffer = lines.pop() ?? "";

      for (const line of lines) flush(line);

      // a tiny yield, so a chatty process cannot starve the event loop
      if (++reads % 25 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }

    flush(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
};

const logFfmpegLine = (line: string, options: TMusicOptions): void => {
  if (/\[(error|fatal|panic)\]/.test(line)) {
    options.error("[FFmpeg]", line);

    return;
  }

  options.log("[FFmpeg]", line);
};

const pendingForcedKill = new WeakSet<object>();

const terminateProcess = (
  process: ReturnType<typeof Bun.spawn> | null,
): void => {
  if (!process) return;

  let exited = false;

  process.exited.finally(() => {
    exited = true;
  });

  try {
    process.kill("SIGTERM");
  } catch {}

  if (pendingForcedKill.has(process as unknown as object)) {
    return;
  }

  pendingForcedKill.add(process as unknown as object);

  setTimeout(() => {
    pendingForcedKill.delete(process as unknown as object);

    if (exited) return;

    try {
      process.kill("SIGKILL");
    } catch {}
  }, FORCE_KILL_TIMEOUT_MS);
};

const spawnMusicStream = async (
  options: TMusicOptions,
): Promise<TMusicStreamResult> => {
  const ffmpegPath = getFfmpegBinaryPath();
  options.log("Using FFmpeg binary at:", ffmpegPath);

  let inputSource = options.sourceUrl;
  let inputArgs: string[] = [];
  let title = options.sourceUrl;
  let thumbnailUrl: string | undefined;
  let durationSeconds: number | undefined;
  let trackId: string | undefined;
  let ytDlpProcess: ReturnType<typeof Bun.spawn> | null = null;
  let videoInputs: { video: string; audio: string } | null = null;
  let videoCodec: TYtDlpTrackInfo["videoCodec"];
  let inputUserAgent: string | undefined;

  const isLocalUrl = (url: string): boolean =>
    url.startsWith("http://127.0.0.1:");

  const reconnectArgs = (userAgent?: string, local = false): string[] => {
    const args = [
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      // googlevideo resets long connections: retry those and 4xx/5xx instead of ending the track
      "-reconnect_on_network_error",
      "1",
      "-reconnect_on_http_error",
      "4xx,5xx",
      // a connection that goes silent without a reset would otherwise hang forever (microseconds)
      "-rw_timeout",
      "15000000",
    ];

    // the chunk proxy already applies the proxy and the headers upstream
    if (options.proxy && !local) {
      args.push("-http_proxy", options.proxy);
    }

    if (userAgent && !local) {
      args.push("-user_agent", userAgent);
    }

    return args;
  };

  const inputSessions: TProxySessionHandle[] = [];

  const closeInputSessions = (): void => {
    for (const session of inputSessions) session.close();
  };

  /** the proxied URL, or the original one if the proxy cannot be set up */
  const proxiedUrl = async (
    url: string,
    label: string,
    track: TYtDlpTrackInfo,
    pick: (fresh: TYtDlpTrackInfo) => string | undefined,
  ): Promise<string> => {
    try {
      const session = await createProxySession({
        label,
        upstreamUrl: url,
        headers: track.httpHeaders,
        proxy: options.proxy,
        log: options.log,
        error: options.error,
        debug: options.debug,
        refreshUrl: async () => {
          const fresh = await resolveYouTubeTrack(
            track.webpageUrl ?? options.sourceUrl,
            {
              log: options.log,
              error: options.error,
              debug: options.debug,
              proxy: options.proxy,
              maxHeight: track.resolvedMaxHeight,
              limitFps: options.limitFps,
            },
          );
          const freshUrl = pick(fresh);
          const sizeOf = (u?: string) => new URL(u ?? "http://x").searchParams.get("clen");

          // a different size means a different format: splicing it in would corrupt the stream
          return freshUrl && sizeOf(freshUrl) === sizeOf(url) ? freshUrl : null;
        },
      });

      inputSessions.push(session);

      return session.url;
    } catch (err) {
      options.error(
        `[chunk-proxy] ${label}: could not start, reading directly instead`,
        err,
      );

      return url;
    }
  };

  if (isYouTubeUrl(options.sourceUrl)) {
    const trackInfo =
      options.preResolvedTrack ??
      (await resolveYouTubeTrack(options.sourceUrl, {
        log: options.log,
        error: options.error,
        debug: options.debug,
        proxy: options.proxy,
      }));

    title = trackInfo.title;
    thumbnailUrl = trackInfo.thumbnailUrl;
    durationSeconds = trackInfo.durationSeconds;
    trackId = trackInfo.id;
    inputUserAgent = trackInfo.httpHeaders?.["User-Agent"];

    const videoWanted =
      options.videoRtpPort !== undefined &&
      options.videoSsrc !== undefined &&
      options.videoPayloadType !== undefined;

    if (
      videoWanted &&
      trackInfo.hasVideo &&
      trackInfo.videoStreamUrl &&
      trackInfo.audioStreamUrl &&
      trackInfo.videoCodec &&
      trackInfo.videoCodec !== "unsupported"
    ) {
      options.log(`Using direct ${trackInfo.videoCodec} video + audio URLs`);

      const muxed = trackInfo.videoStreamUrl === trackInfo.audioStreamUrl;
      const videoUrl = await proxiedUrl(
        trackInfo.videoStreamUrl,
        muxed ? "video+audio" : "video",
        trackInfo,
        (fresh) => fresh.videoStreamUrl,
      );

      videoInputs = {
        video: videoUrl,
        audio: muxed
          ? videoUrl
          : await proxiedUrl(
              trackInfo.audioStreamUrl,
              "audio",
              trackInfo,
              (fresh) => fresh.audioStreamUrl,
            ),
      };
      videoCodec = trackInfo.videoCodec;
    } else if (trackInfo.streamUrl) {
      options.log("Using direct stream URL for YouTube audio");
      inputSource = await proxiedUrl(
        trackInfo.streamUrl,
        "audio",
        trackInfo,
        (fresh) => fresh.streamUrl,
      );
      inputArgs = reconnectArgs(inputUserAgent, isLocalUrl(inputSource));
    } else {
      options.log("Direct stream URL unavailable, falling back to yt-dlp pipe");
      ytDlpProcess = await spawnYouTubeAudioPipe(
        trackInfo.webpageUrl ?? options.sourceUrl,
        {
          log: options.log,
          error: options.error,
          debug: options.debug,
          proxy: options.proxy,
        },
      );

      if (!ytDlpProcess.stdout) {
        throw new Error("yt-dlp pipe is not available");
      }

      inputSource = "pipe:0";
      inputArgs = [];
    }
  } else {
    inputArgs = reconnectArgs();
  }

  const volumeLevel = Math.min(100, Math.max(0, options.volume ?? 100)) / 100;

  const normalizeBitrate = (bitrate?: string): string => {
    if (!bitrate) return "192k";
    const trimmed = bitrate.trim();

    if (!trimmed) return "192k";

    if (/^\d+(?:\.\d+)?k$/i.test(trimmed)) return trimmed.toLowerCase();
    if (/^\d+$/.test(trimmed)) return trimmed;

    return "192k";
  };

  const audioBitrate = normalizeBitrate(options.bitrate);

  if (audioBitrate === "192k" && options.bitrate) {
    options.log(
      "Invalid bitrate setting, using default 192k:",
      options.bitrate,
    );
  }

  options.debug("Using audio bitrate:", audioBitrate);

  let controlPort: number | undefined;
  try {
    controlPort = await getAvailablePort();
  } catch (err) {
    options.debug("Could not allocate port for azmq volume control:", err);
  }

  const audioFilter = controlPort
    ? `volume=${volumeLevel},azmq=bind_address=tcp\\\\://127.0.0.1\\\\:${controlPort}`
    : `volume=${volumeLevel}`;

  const audioOutputArgs = [
    "-af",
    audioFilter,
    "-c:a",
    "libopus",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    audioBitrate,
    "-application",
    "audio",

    "-payload_type",
    String(options.audioPayloadType),
    "-ssrc",
    String(options.audioSsrc),
    "-f",
    "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?${RTP_OUTPUT_QUERY}`,
  ];

  // -re paces each input to real time, so both inputs need their own
  const pacedInput = (url: string): string[] => [
    ...reconnectArgs(inputUserAgent, isLocalUrl(url)),
    "-re",
    "-readrate_initial_burst",
    String(INPUT_INITIAL_BURST_SECONDS),
    "-i",
    url,
  ];

  const commonArgs = ["-hide_banner", "-nostats", "-loglevel", "level+warning"];

  let ffmpegArgs: string[];

  if (videoInputs && videoCodec && videoCodec !== "unsupported") {
    // muxed sources hand back one URL for both: open it once, map both streams
    const singleInput = videoInputs.video === videoInputs.audio;

    const targetHeight = options.videoMaxHeight ?? 720;
    const h264Bitrate =
      H264_TRANSCODE_BITRATES[targetHeight] ?? H264_TRANSCODE_BITRATES[720]!;
    const h264Rate = Number.parseInt(h264Bitrate, 10);

    const videoCodecArgs =
      videoCodec === "vp9"
        ? [
            "-c:v",
            "copy",
            // FFmpeg still flags its VP9 RTP packetizer as experimental
            "-strict",
            "experimental",
          ]
        : [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-profile:v",
            "baseline",
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            h264Bitrate,
            "-maxrate",
            `${Math.round(h264Rate * 1.2)}k`,
            "-bufsize",
            `${h264Rate * 2}k`,
            // a keyframe every 2 seconds so late joiners recover quickly
            "-force_key_frames",
            "expr:gte(t,n_forced*2)",
            "-bsf:v",
            "dump_extra=freq=keyframe",
          ];

    if (videoCodec === "h264") {
      options.log(
        "H.264 source: re-encoding without B-frames for monotonic RTP timestamps",
      );
    }

    const videoOutputArgs = [
      "-map",
      "0:v:0",
      ...videoCodecArgs,
      "-payload_type",
      String(options.videoPayloadType),
      "-ssrc",
      String(options.videoSsrc),
      "-f",
      "rtp",
      `rtp://${options.rtpHost}:${options.videoRtpPort}?${RTP_OUTPUT_QUERY}`,
    ];

    ffmpegArgs = [
      ...commonArgs,
      ...pacedInput(videoInputs.video),
      ...(singleInput ? [] : pacedInput(videoInputs.audio)),
      ...videoOutputArgs,
      "-map",
      singleInput ? "0:a:0" : "1:a:0",
      ...audioOutputArgs,
    ];
  } else {
    ffmpegArgs = [
      ...commonArgs,
      ...inputArgs,
      "-re",
      "-readrate_initial_burst",
      String(INPUT_INITIAL_BURST_SECONDS),
      "-i",
      inputSource,
      "-vn",
      ...audioOutputArgs,
    ];
  }

  options.debug("Starting music stream with FFmpeg...");
  options.debug("Command:", ffmpegPath, ...ffmpegArgs);

  let ffmpegProcess: ReturnType<typeof Bun.spawn>;

  try {
    ffmpegProcess = Bun.spawn({
      cmd: [ffmpegPath, ...ffmpegArgs],
      stdout: "ignore",
      stderr: "pipe",
      stdin: ytDlpProcess?.stdout ?? "ignore",
    });
  } catch (err) {
    closeInputSessions();
    throw err;
  }

  if (ffmpegProcess.stderr) {
    readLines(ffmpegProcess.stderr, (line) =>
      logFfmpegLine(line, options),
    ).catch((err: unknown) => options.error("[FFmpeg stderr error]", err));
  }

  // extractor, proxy and cookie diagnostics, most of it routine progress
  if (ytDlpProcess?.stderr && typeof ytDlpProcess.stderr !== "number") {
    readLines(ytDlpProcess.stderr, (line) => logYtDlpLine(line, options)).catch(
      (err: unknown) => options.error("[yt-dlp stderr error]", err),
    );
  }

  if (ytDlpProcess) {
    ytDlpProcess.exited.then((exitCode) => {
      if (exitCode !== 0) {
        options.error(`[yt-dlp] exited with code ${exitCode}`);
      } else {
        options.debug("[yt-dlp] stream finished");
      }
    });
  }

  ffmpegProcess.exited.then(() => {
    closeInputSessions();

    if (ytDlpProcess) {
      terminateProcess(ytDlpProcess);
    }

    options.onEnd?.();
  });

  return {
    process: { ffmpeg: ffmpegProcess, ytDlp: ytDlpProcess, inputSessions },
    controlPort,
    title,
    thumbnailUrl,
    durationSeconds,
    id: trackId,
    hasVideo: videoInputs !== null,
  };
};

const killMusicStream = (process: TSpawnedStreamProcess | null): void => {
  if (!process) return;

  terminateProcess(process.ffmpeg);

  for (const session of process.inputSessions) session.close();

  if (process.ytDlp) {
    terminateProcess(process.ytDlp);
  }
};

export { spawnMusicStream, killMusicStream };
export type { TMusicOptions, TMusicStreamResult, TSpawnedStreamProcess };
