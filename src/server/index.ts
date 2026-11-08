import {
  Permission,
  PluginSlot,
  type PluginContext,
  type UnloadPluginContext,
} from "@sharkord/plugin-sdk";
import type { PlayerActionResponse, TSharkord } from "../contract";
import {
  areRequiredBinariesPresent,
  downloadBinary,
  ensureRequiredBinaries,
  isBinaryDownloading,
  type TBinaryName,
} from "./downloads";
import { stopChunkProxy } from "./chunk-proxy";
import { killMusicStream, spawnMusicStream } from "./ffmpeg";
import { setDataDir } from "./paths";
import {
  clearAllChannelStates,
  enqueueSource,
  formatSourceLabel,
  getChannelIds,
  getExistingState,
  getPlayerStateSnapshot,
  getState,
  recordPlayedVideo,
  removeQueueItem,
  takeNextFromQueue,
} from "./player-state";
import { sendFfmpegVolumeCommand } from "./volume-control";
import {
  buildVideoRtpCodecs,
  DEFAULT_MAX_RESOLUTION,
  formatVideoLabel,
  getVideoPayloadType,
  MAX_RESOLUTIONS,
  parseBooleanSetting,
  parseMaxResolution,
} from "./video";
import {
  extractYouTubeVideoId,
  fetchYouTubeRelatedTracks,
  isYouTubeUrl,
  resolveYouTubeTrack,
  type TYtDlpOptions,
  type TYtDlpTrackInfo,
} from "./yt-dlp";

type TMusicContext = PluginContext<TSharkord>;

type TCleanupContext = Pick<TMusicContext, "logger"> &
  Partial<Pick<TMusicContext, "push">>;

type PlaybackSettings = {
  bitrate: string;
  proxy?: string;
  /** set per channel from the in-panel Video toggle, not from the plugin settings */
  streamVideo: boolean;
  maxResolution: number;
  limitFps: boolean;
};

/** the height to resolve for: 0 means audio only */
const getVideoHeight = (options: PlaybackSettings): number =>
  options.streamVideo ? options.maxResolution : 0;

const buildYtDlpOptions = (
  ctx: TMusicContext,
  options: PlaybackSettings,
): TYtDlpOptions => ({
  log: ctx.logger.log,
  error: ctx.logger.error,
  debug: ctx.logger.debug,
  proxy: options.proxy,
  maxHeight: getVideoHeight(options),
  limitFps: options.limitFps,
});

let binariesReady = false;
let binariesInitError: Error | null = null;

const publishPlayerState = (ctx: TCleanupContext, channelId: number): void => {
  ctx.push?.toAll({ channelId, player: getPlayerStateSnapshot(channelId) });
};

const cleanupChannel = (ctx: TCleanupContext, channelId: number): void => {
  const state = getExistingState(channelId);

  if (!state) return;

  killMusicStream(state.ffmpegProcess);

  state.ffmpegProcess = null;

  if (state.producerCloseHandler && state.audioProducer) {
    state.audioProducer.observer.off("close", state.producerCloseHandler);
  }

  if (state.videoProducerCloseHandler && state.videoProducer) {
    state.videoProducer.observer.off("close", state.videoProducerCloseHandler);
  }

  if (state.routerCloseHandler && state.router) {
    state.router.off("@close", state.routerCloseHandler);
  }

  try {
    state.streamHandle?.remove();
  } catch {}

  try {
    state.audioProducer?.close();
  } catch {}

  try {
    state.videoProducer?.close();
  } catch {}

  try {
    state.audioTransport?.close();
  } catch {}

  try {
    state.videoTransport?.close();
  } catch {}

  state.streamHandle = null;
  state.audioProducer = null;
  state.audioTransport = null;
  state.videoProducer = null;
  state.videoTransport = null;
  state.videoProducerCloseHandler = null;
  state.activeVideoCodec = null;
  state.currentVideoLabel = null;
  state.router = null;
  state.routerCloseHandler = null;
  state.producerCloseHandler = null;
  state.streamActive = false;
  state.streamStarting = false;
  state.currentSong = null;
  state.currentInvokerUserId = null;
  state.currentThumbnailUrl = null;
  state.playbackStartedAtEpochMs = null;
  state.currentTrackDurationSeconds = null;
  state.volumeControlPort = null;

  publishPlayerState(ctx, channelId);
};

const startBinaryBootstrap = (ctx: TMusicContext): void => {
  binariesReady = false;
  binariesInitError = null;

  ensureRequiredBinaries(ctx.logger)
    .then(() => {
      binariesReady = true;
      ctx.logger.log("Required music binaries are ready");
    })
    .catch((err: unknown) => {
      binariesInitError = err instanceof Error ? err : new Error(String(err));
      ctx.logger.error("Failed to prepare required music binaries", err);
    });
};

const assertStreamingBinariesReady = async (): Promise<void> => {
  if (binariesInitError) {
    throw new Error(
      `Failed to prepare required binaries: ${binariesInitError.message}`,
    );
  }

  if (binariesReady || (await areRequiredBinariesPresent())) {
    binariesReady = true;
    return;
  }

  throw new Error(
    "Required music binaries are still downloading. Try again in a moment.",
  );
};

const requireVoiceChannelId = (
  channelId: number | null | undefined,
  errorMessage: string,
): number => {
  if (!channelId) {
    throw new Error(errorMessage);
  }

  return channelId;
};

const normalizePlayableSource = (query: string): string => {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("You must provide a search query or URL.");
  }

  if (!/^https?:\/\//.test(trimmedQuery)) {
    return `ytsearch:${trimmedQuery}`;
  }

  return trimmedQuery;
};

const suggestionCache = new Map<string, { timestamp: number; data: string[] }>();
const SUGGESTION_CACHE_TTL_MS = 10 * 60 * 1000;

const fetchSearchSuggestions = async (query: string): Promise<string[]> => {
  const q = query.trim();

  if (q.length <= 2 || /^https?:\/\//.test(q)) {
    return [];
  }

  const cacheKey = q.toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUGGESTION_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/120.0",
        Accept: "application/json, text/plain, */*",
      },
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return [];
    }

    const json = (await response.json()) as unknown;
    if (Array.isArray(json) && Array.isArray(json[1])) {
      const results = json[1]
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, 7);

      suggestionCache.set(cacheKey, { timestamp: Date.now(), data: results });

      if (suggestionCache.size > 200) {
        const oldestKey = suggestionCache.keys().next().value;
        if (oldestKey) suggestionCache.delete(oldestKey);
      }

      return results;
    }

    return [];
  } catch {
    return [];
  }
};

const buildActionResult = (
  ctx: TMusicContext,
  message: string,
  channelId: number,
): PlayerActionResponse => {
  publishPlayerState(ctx, channelId);

  return { message, player: getPlayerStateSnapshot(channelId) };
};

const triggerPrefetchNext = (
  ctx: TMusicContext,
  channelId: number,
  options: PlaybackSettings,
): void => {
  const state = getExistingState(channelId);

  if (!state) return;

  if (state.queue.length === 0) {
    if (
      state.autoplay &&
      state.lastPlayedVideoId &&
      !state.prefetchedAutoplayTrack &&
      !state.autoplayPrefetchPromise
    ) {
      ctx.logger.debug(
        "Autoplay active with empty queue; prefetching related track for:",
        state.lastPlayedVideoId,
      );

      const promise = (async () => {
        try {
          const related = await fetchYouTubeRelatedTracks(
            state.lastPlayedVideoId!,
            {
              log: ctx.logger.log,
              error: ctx.logger.error,
              debug: ctx.logger.debug,
              proxy: options.proxy,
            },
            state.currentSong ?? undefined,
          );

          const candidate =
            related.find((r) => !state.recentVideoIds.includes(r.id)) ??
            related[0];

          if (!candidate) return null;

          const trackInfo = await resolveYouTubeTrack(
            candidate.url,
            buildYtDlpOptions(ctx, options),
          );

          state.prefetchedAutoplayTrack = trackInfo;
          ctx.logger.log("Prefetched autoplay track:", trackInfo.title);
          return trackInfo;
        } catch (err) {
          ctx.logger.error("Failed to prefetch autoplay track", err);
          return null;
        } finally {
          state.autoplayPrefetchPromise = null;
        }
      })();

      state.autoplayPrefetchPromise = promise;
    }
    return;
  }

  for (const item of state.queue) {
    if (item.resolvedTrack || item.prefetchPromise) continue;

    if (!isYouTubeUrl(item.sourceUrl)) {
      continue;
    }

    ctx.logger.debug("Prefetching track in queue:", item.sourceUrl);

    const prefetchPromise = resolveYouTubeTrack(
      item.sourceUrl,
      buildYtDlpOptions(ctx, options),
    )
      .then((trackInfo) => {
        item.resolvedTrack = trackInfo;
        ctx.logger.log("Prefetched queued track:", trackInfo.title);
        publishPlayerState(ctx, channelId);
        return trackInfo;
      })
      .catch((err: unknown) => {
        ctx.logger.error("Failed to prefetch track in queue", err);
        throw err;
      })
      .finally(() => {
        item.prefetchPromise = null;
      });

    item.prefetchPromise = prefetchPromise;
  }
};

// how long viewers get to attach to a new video stream before FFmpeg starts
const VIDEO_VIEWER_SETUP_DELAY_MS = 2000;

const startMusicStream = async (
  ctx: TMusicContext,
  channelId: number,
  sourceUrl: string,
  options: PlaybackSettings,
  invokerUserId: number,
  preResolvedTrack?: TYtDlpTrackInfo,
): Promise<string> => {
  const state = getState(channelId);

  if (state.streamActive) {
    throw new Error("Music is already playing in this channel.");
  }

  if (state.streamStarting) {
    throw new Error("Music is already starting. Please wait.");
  }

  state.streamStarting = true;
  publishPlayerState(ctx, channelId);

  try {
    // resolve first: the video codec decides which producer to create
    let trackInfo = preResolvedTrack;

    if (isYouTubeUrl(sourceUrl)) {
      const wantedHeight = getVideoHeight(options);

      // a prefetch made under other video settings has the wrong formats
      if (!trackInfo || trackInfo.resolvedMaxHeight !== wantedHeight) {
        trackInfo = await resolveYouTubeTrack(
          trackInfo?.webpageUrl ?? sourceUrl,
          buildYtDlpOptions(ctx, options),
        );
      }
    }

    const router = ctx.voice.getRouter(channelId);
    const { announcedAddress, ip } = ctx.voice.getListenInfo();

    state.router = router;

    state.routerCloseHandler = () => {
      ctx.logger.log("Router closed, cleaning up channel", channelId);
      cleanupChannel(ctx, channelId);
    };

    router.on("@close", state.routerCloseHandler);

    const audioSsrc = Math.floor(Math.random() * 1e9);

    state.audioTransport = await router.createPlainTransport({
      listenIp: {
        ip,
        announcedIp: announcedAddress,
      },
      rtcpMux: true,
      comedia: true,
      enableSrtp: false,
    });

    state.audioProducer = await state.audioTransport.produce({
      kind: "audio",
      rtpParameters: {
        codecs: [
          {
            mimeType: "audio/opus",
            payloadType: 111,
            clockRate: 48000,
            channels: 2,
            parameters: {},
            rtcpFeedback: [],
          },
        ],
        encodings: [{ ssrc: audioSsrc }],
      },
    });

    const videoCodec =
      trackInfo?.hasVideo &&
      trackInfo.videoCodec &&
      trackInfo.videoCodec !== "unsupported"
        ? trackInfo.videoCodec
        : null;
    const videoSsrc = Math.floor(Math.random() * 1e9);

    if (videoCodec) {
      try {
        state.videoTransport = await router.createPlainTransport({
          listenIp: {
            ip,
            announcedIp: announcedAddress,
          },
          rtcpMux: true,
          comedia: true,
          enableSrtp: false,
        });

        state.videoProducer = await state.videoTransport.produce({
          kind: "video",
          rtpParameters: {
            codecs: buildVideoRtpCodecs(videoCodec),
            encodings: [{ ssrc: videoSsrc }],
          },
        });

        state.activeVideoCodec = videoCodec;
        state.currentVideoLabel = formatVideoLabel(
          trackInfo?.videoHeight,
          videoCodec,
        );
      } catch (err) {
        // the router may not accept this codec; audio still plays
        ctx.logger.error(
          `Could not create the ${videoCodec} video producer, continuing with audio only`,
          err,
        );

        try {
          state.videoProducer?.close();
        } catch {}

        try {
          state.videoTransport?.close();
        } catch {}

        state.videoProducer = null;
        state.videoTransport = null;
        state.activeVideoCodec = null;
        state.currentVideoLabel = null;
      }
    }

    ctx.logger.log("Final source URL:", sourceUrl);

    state.streamHandle = ctx.voice.createStream({
      key: "music",
      channelId,
      title: trackInfo?.title ?? sourceUrl,
      avatarUrl: "https://i.imgur.com/uVBNUK9.png",
      bannerUrl: trackInfo?.thumbnailUrl,
      producers: {
        audio: state.audioProducer,
        video: state.videoProducer ?? undefined,
      },
    });

    // Announce the stream before FFmpeg sends anything. Video is forwarded
    // as-is, so the first keyframe leaves at t=0 and the next one can be several
    // seconds away; a viewer that is still attaching when it goes by sees a black
    // tile until then (FFmpeg cannot answer keyframe requests in copy mode).
    if (state.videoProducer) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, VIDEO_VIEWER_SETUP_DELAY_MS),
      );

      if (state.audioProducer?.closed || state.videoProducer?.closed) {
        throw new Error("The stream was stopped while it was starting.");
      }
    }

    const result = await spawnMusicStream({
      sourceUrl,
      audioPayloadType: 111,
      audioSsrc,
      rtpHost: ip,
      audioRtpPort: state.audioTransport.tuple.localPort,
      ...(state.videoTransport && state.activeVideoCodec
        ? {
            videoPayloadType: getVideoPayloadType(state.activeVideoCodec),
            videoSsrc,
            videoRtpPort: state.videoTransport.tuple.localPort,
          }
        : {}),
      volume: state.volume,
      bitrate: options.bitrate,
      proxy: options.proxy,
      limitFps: options.limitFps,
      videoMaxHeight: trackInfo?.resolvedMaxHeight,
      preResolvedTrack: trackInfo,
      log: ctx.logger.log,
      error: ctx.logger.error,
      debug: ctx.logger.debug,
      onEnd: () => {
        ctx.logger.log("Music ended in channel", channelId);

        const queueHasItems = state.queue.length > 0;
        const shouldStartNext =
          state.endAction === "next" ||
          (state.endAction !== "stop" && (queueHasItems || state.autoplay));

        state.endAction = "none";
        cleanupChannel(ctx, channelId);

        if (shouldStartNext) {
          playNextInQueue(ctx, channelId, options).catch((err: unknown) =>
            ctx.logger.error("Failed to start the next track", err),
          );
        }
      },
    });

    // tracked right away, so a failure below still tears ffmpeg and its proxy down
    state.ffmpegProcess = result.process;

    state.producerCloseHandler = () => cleanupChannel(ctx, channelId);

    state.audioProducer.observer.on("close", state.producerCloseHandler);

    if (state.videoProducer) {
      state.videoProducerCloseHandler = () => cleanupChannel(ctx, channelId);

      state.videoProducer.observer.on("close", state.videoProducerCloseHandler);
    }

    const videoId = result.id ?? extractYouTubeVideoId(sourceUrl);
    if (videoId) {
      recordPlayedVideo(channelId, videoId);
    }

    state.ffmpegProcess = result.process;
    state.volumeControlPort = result.controlPort ?? null;
    state.currentSong = result.title;
    state.currentInvokerUserId = invokerUserId;
    state.currentThumbnailUrl = result.thumbnailUrl ?? null;
    state.playbackStartedAtEpochMs = Date.now();
    state.currentTrackDurationSeconds = result.durationSeconds ?? null;
    state.streamActive = true;
    state.streamStarting = false;
    state.endAction = "none";

    publishPlayerState(ctx, channelId);
    triggerPrefetchNext(ctx, channelId, options);

    return `Now playing: ${result.title}`;
  } catch (err) {
    cleanupChannel(ctx, channelId);
    throw err;
  } finally {
    state.streamStarting = false;
  }
};

const playNextInQueue = async (
  ctx: TMusicContext,
  channelId: number,
  options: PlaybackSettings,
): Promise<string> => {
  const nextItem = takeNextFromQueue(channelId);

  if (!nextItem) {
    const state = getState(channelId);
    if (state.autoplay && state.lastPlayedVideoId) {
      let autoplayTrack = state.prefetchedAutoplayTrack;
      state.prefetchedAutoplayTrack = null;

      if (!autoplayTrack && state.autoplayPrefetchPromise) {
        try {
          autoplayTrack = await state.autoplayPrefetchPromise;
        } catch {}
      }

      if (!autoplayTrack) {
        try {
          const related = await fetchYouTubeRelatedTracks(
            state.lastPlayedVideoId,
            {
              log: ctx.logger.log,
              error: ctx.logger.error,
              debug: ctx.logger.debug,
              proxy: options.proxy,
            },
            state.currentSong ?? undefined,
          );
          const candidate =
            related.find((r) => !state.recentVideoIds.includes(r.id)) ??
            related[0];

          if (candidate) {
            autoplayTrack = await resolveYouTubeTrack(
              candidate.url,
              buildYtDlpOptions(ctx, options),
            );
          }
        } catch (err) {
          ctx.logger.error("Failed to fetch autoplay track on queue end", err);
        }
      }

      if (autoplayTrack) {
        ctx.logger.log("Autoplay starting next track:", autoplayTrack.title);
        const invokerUserId = state.currentInvokerUserId ?? 0;
        return startMusicStream(
          ctx,
          channelId,
          autoplayTrack.webpageUrl,
          options,
          invokerUserId,
          autoplayTrack,
        );
      }
    }

    publishPlayerState(ctx, channelId);

    return "Queue is empty.";
  }

  const state = getState(channelId);
  state.prefetchedAutoplayTrack = null;

  let preResolved = nextItem.resolvedTrack ?? undefined;

  if (!preResolved && nextItem.prefetchPromise) {
    try {
      preResolved = await nextItem.prefetchPromise;
    } catch {}
  }

  return startMusicStream(
    ctx,
    channelId,
    nextItem.sourceUrl,
    options,
    nextItem.invokerUserId,
    preResolved,
  );
};

const onLoad = async (ctx: TMusicContext) => {
  setDataDir(ctx.dataPath);
  startBinaryBootstrap(ctx);

  ctx.logger.log("Music Bot loaded");

  // the panel is only useful to someone who can be in a voice channel; owners
  // narrow this further per role in the plugin's permissions
  ctx.ui.enable({ [PluginSlot.TOPBAR_RIGHT]: Permission.JOIN_VOICE_CHANNELS });

  const settings = await ctx.settings.register([
    {
      key: "bitrate",
      name: "Bitrate",
      description: "The bitrate for the music stream",
      type: "string",
      defaultValue: "128k",
    },
    {
      key: "maxResolution",
      name: "Max Resolution",
      description: `Highest video resolution to stream (${MAX_RESOLUTIONS.map((r) => `${r}p`).join(", ")}). Video is copied, not transcoded, so higher resolutions cost bandwidth rather than CPU. Resolutions above 1080p are VP9 only.`,
      type: "string",
      defaultValue: `${DEFAULT_MAX_RESOLUTION}p`,
    },
    {
      key: "limitFps",
      name: "Limit to 30 fps",
      description:
        "Prefer 30 fps (or lower) video. Video is copied untouched, so 60 fps roughly doubles the bandwidth and the chance of stutter. Falls back to 60 fps when nothing else exists.",
      type: "boolean",
      defaultValue: false,
    },
    {
      key: "proxy",
      name: "Proxy URL",
      description:
        "Optional proxy URL for YouTube requests (e.g. http://localhost:8080)",
      type: "string",
      defaultValue: "",
    },
  ] as const);

  const getPlaybackSettings = (channelId: number): PlaybackSettings => ({
    bitrate: settings.get("bitrate"),
    proxy: settings.get("proxy"),
    streamVideo: getState(channelId).videoEnabled,
    maxResolution: parseMaxResolution(settings.get("maxResolution")),
    limitFps: parseBooleanSetting(settings.get("limitFps"), false),
  });

  ctx.events.on("voice:runtime_closed", ({ channelId }) => {
    const state = getExistingState(channelId);

    if (state) {
      state.endAction = "stop";
    }

    cleanupChannel(ctx, channelId);
  });

  ctx.actions.register({
    name: "getPlayerState",
    description: "Reads what is playing in the caller's voice channel",
    executes: async (invoker) =>
      getPlayerStateSnapshot(invoker.currentVoiceChannelId),
  });

  ctx.actions.register({
    name: "getSearchSuggestions",
    description: "Fetches YouTube search suggestions for a query",
    executes: async (_invoker, payload) => {
      const query = typeof payload?.query === "string" ? payload.query : "";
      return fetchSearchSuggestions(query);
    },
  });

  ctx.actions.register({
    name: "playMusic",
    description: "Plays a track, or queues it when something is already on",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker, payload) => {
      await assertStreamingBinariesReady();

      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to play music.",
      );
      const sourceUrl = normalizePlayableSource(payload.query);
      const state = getState(channelId);

      if (state.streamActive || state.streamStarting) {
        const position = enqueueSource(channelId, sourceUrl, invoker.userId);

        publishPlayerState(ctx, channelId);

        triggerPrefetchNext(ctx, channelId, getPlaybackSettings(channelId));

        return buildActionResult(
          ctx,
          `Added to queue (#${position}): ${formatSourceLabel(sourceUrl)}`,
          channelId,
        );
      }

      const message = await startMusicStream(
        ctx,
        channelId,
        sourceUrl,
        getPlaybackSettings(channelId),
        invoker.userId,
      );

      return buildActionResult(ctx, message, channelId);
    },
  });

  ctx.actions.register({
    name: "removeQueueItem",
    description: "Removes one track from the queue",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker, payload) => {
      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to edit the queue.",
      );
      const removedItem = removeQueueItem(channelId, payload.position);

      if (!removedItem) {
        throw new Error("Queue item not found.");
      }

      triggerPrefetchNext(ctx, channelId, getPlaybackSettings(channelId));

      return buildActionResult(
        ctx,
        `Removed from queue: ${formatSourceLabel(removedItem.sourceUrl)}`,
        channelId,
      );
    },
  });

  ctx.actions.register({
    name: "nextMusic",
    description: "Skips to the next queued track",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker) => {
      await assertStreamingBinariesReady();

      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to skip music.",
      );
      const state = getState(channelId);

      if (state.streamStarting) {
        throw new Error("Music is still starting. Try again in a moment.");
      }

      if (!state.streamActive) {
        const message = await playNextInQueue(
          ctx,
          channelId,
          getPlaybackSettings(channelId),
        );

        return buildActionResult(ctx, message, channelId);
      }

      // the ffmpeg exit handler picks the next track up
      state.endAction = "next";
      cleanupChannel(ctx, channelId);

      return buildActionResult(ctx, "Skipping current track...", channelId);
    },
  });

  ctx.actions.register({
    name: "jumpToQueueItem",
    description: "Plays a queued track right away",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker, payload) => {
      await assertStreamingBinariesReady();

      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to control the queue.",
      );
      const state = getState(channelId);
      const selectedItem = removeQueueItem(channelId, payload.position);

      if (!selectedItem) {
        throw new Error("Queue item not found.");
      }

      if (!state.streamActive) {
        let preResolved = selectedItem.resolvedTrack ?? undefined;

        if (!preResolved && selectedItem.prefetchPromise) {
          try {
            preResolved = await selectedItem.prefetchPromise;
          } catch {}
        }

        const message = await startMusicStream(
          ctx,
          channelId,
          selectedItem.sourceUrl,
          getPlaybackSettings(channelId),
          selectedItem.invokerUserId,
          preResolved,
        );

        return buildActionResult(ctx, message, channelId);
      }

      state.queue.unshift(selectedItem);
      triggerPrefetchNext(ctx, channelId, getPlaybackSettings(channelId));
      state.endAction = "next";
      cleanupChannel(ctx, channelId);

      return buildActionResult(
        ctx,
        `Jumping to: ${formatSourceLabel(selectedItem.sourceUrl)}`,
        channelId,
      );
    },
  });

  ctx.actions.register({
    name: "setVolume",
    description: "Sets the channel's master volume live for active and upcoming tracks",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker, payload) => {
      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to change the volume.",
      );

      if (!Number.isFinite(payload.volume)) {
        throw new Error("Volume must be a number between 0 and 100.");
      }

      const volume = Math.min(100, Math.max(0, Math.round(payload.volume)));
      const state = getState(channelId);
      state.volume = volume;

      if (state.streamActive && state.volumeControlPort) {
        sendFfmpegVolumeCommand(state.volumeControlPort, volume / 100).catch((err) => {
          ctx.logger.error("Failed to update live FFmpeg volume", err);
        });
      }

      publishPlayerState(ctx, channelId);

      return buildActionResult(
        ctx,
        `Volume set to ${volume}%.`,
        channelId,
      );
    },
  });

  ctx.actions.register({
    name: "stopMusic",
    description: "Stops playback and clears the channel's playback state",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker) => {
      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to stop music.",
      );
      const state = getExistingState(channelId);

      if (state) {
        state.endAction = "stop";
        state.prefetchedAutoplayTrack = null;
      }

      // unconditional, so a half started stream is recoverable too
      cleanupChannel(ctx, channelId);

      return buildActionResult(ctx, "Stopped music.", channelId);
    },
  });

  ctx.actions.register({
    name: "toggleAutoplay",
    description:
      "Toggles autoplay for YouTube recommendations when the queue ends",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker) => {
      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to toggle autoplay.",
      );
      const state = getState(channelId);
      state.autoplay = !state.autoplay;

      if (state.autoplay) {
        triggerPrefetchNext(ctx, channelId, getPlaybackSettings(channelId));
      } else {
        state.prefetchedAutoplayTrack = null;
      }

      return buildActionResult(
        ctx,
        `Autoplay is now ${state.autoplay ? "enabled" : "disabled"}.`,
        channelId,
      );
    },
  });

  ctx.actions.register({
    name: "toggleVideo",
    description:
      "Switches between streaming YouTube video with the audio, or audio only",
    requires: Permission.JOIN_VOICE_CHANNELS,
    executes: async (invoker) => {
      const channelId = requireVoiceChannelId(
        invoker.currentVoiceChannelId,
        "You must be in a voice channel to toggle video.",
      );
      const state = getState(channelId);
      state.videoEnabled = !state.videoEnabled;

      // a track queued ahead was resolved for the old choice; it is
      // re-resolved when it starts, so nothing else needs to change here
      return buildActionResult(
        ctx,
        `Video is now ${state.videoEnabled ? "enabled" : "disabled"} (from the next track).`,
        channelId,
      );
    },
  });

  const registerUpdateCommand = (
    name: "update-ffmpeg" | "update-yt-dlp",
    binary: TBinaryName,
  ) =>
    ctx.commands.register({
      name,
      description: `Downloads the latest ${binary} build`,
      requires: Permission.MANAGE_PLUGINS,
      executes: async () => {
        if (isBinaryDownloading(binary)) {
          return `${binary} is already downloading. Follow it in the plugin logs.`;
        }

        downloadBinary(binary, ctx.logger)
          .then(async () => {
            ctx.logger.log(`Updated ${binary} to the latest build`);

            // a manual download is also how you recover from a failed bootstrap
            binariesInitError = null;
            binariesReady = await areRequiredBinariesPresent();
          })
          .catch((err: unknown) =>
            ctx.logger.error(`Failed to update ${binary}`, err),
          );

        return `Downloading the latest ${binary}. Follow it in the plugin logs.`;
      },
    });

  registerUpdateCommand("update-ffmpeg", "ffmpeg");
  registerUpdateCommand("update-yt-dlp", "yt-dlp");
};

const onUnload = (ctx: UnloadPluginContext) => {
  for (const channelId of getChannelIds()) {
    const state = getExistingState(channelId);

    if (state) {
      state.endAction = "stop";
    }

    cleanupChannel(ctx, channelId);
  }

  clearAllChannelStates();
  stopChunkProxy();

  ctx.logger.log("Music Bot unloaded");
};

export { onLoad, onUnload };
