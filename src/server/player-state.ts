import type {
  AppData,
  PlainTransport,
  Producer,
  Router,
  TExternalStreamHandle,
} from "@sharkord/plugin-sdk";
import type { PlayerQueueEntry, PlayerStateSnapshot } from "../contract";
import type { TMusicStreamResult } from "./ffmpeg";
import type { TYtDlpTrackInfo } from "./yt-dlp";

type TQueueItem = {
  sourceUrl: string;
  invokerUserId: number;
  resolvedTrack?: TYtDlpTrackInfo | null;
  prefetchPromise?: Promise<TYtDlpTrackInfo> | null;
};

type ChannelStreamState = {
  ffmpegProcess: TMusicStreamResult["process"] | null;
  audioProducer: Producer | null;
  audioTransport: PlainTransport<AppData> | null;
  router: Router<AppData> | null;
  streamHandle: TExternalStreamHandle | null;
  routerCloseHandler: ((...args: unknown[]) => void) | null;
  producerCloseHandler: ((...args: unknown[]) => void) | null;
  currentSong: string | null;
  currentInvokerUserId: number | null;
  currentThumbnailUrl: string | null;
  streamActive: boolean;
  streamStarting: boolean;
  playbackStartedAtEpochMs: number | null;
  currentTrackDurationSeconds: number | null;
  volume: number;
  queue: TQueueItem[];
  endAction: "none" | "next" | "stop";
  autoplay: boolean;
  lastPlayedVideoId: string | null;
  recentVideoIds: string[];
  prefetchedAutoplayTrack: TYtDlpTrackInfo | null;
  autoplayPrefetchPromise: Promise<TYtDlpTrackInfo | null> | null;
};

const DEFAULT_VOLUME = 50;

const channelStreams = new Map<number, ChannelStreamState>();

const createInitialState = (): ChannelStreamState => ({
  ffmpegProcess: null,
  audioProducer: null,
  audioTransport: null,
  router: null,
  streamHandle: null,
  routerCloseHandler: null,
  producerCloseHandler: null,
  currentSong: null,
  currentInvokerUserId: null,
  currentThumbnailUrl: null,
  streamActive: false,
  streamStarting: false,
  playbackStartedAtEpochMs: null,
  currentTrackDurationSeconds: null,
  volume: DEFAULT_VOLUME,
  queue: [],
  endAction: "none",
  autoplay: false,
  lastPlayedVideoId: null,
  recentVideoIds: [],
  prefetchedAutoplayTrack: null,
  autoplayPrefetchPromise: null,
});

const getState = (channelId: number): ChannelStreamState => {
  let state = channelStreams.get(channelId);

  if (!state) {
    state = createInitialState();
    channelStreams.set(channelId, state);
  }

  return state;
};

const getExistingState = (channelId: number): ChannelStreamState | undefined =>
  channelStreams.get(channelId);

const formatSourceLabel = (sourceUrl: string): string => {
  if (sourceUrl.startsWith("ytsearch:")) {
    return sourceUrl.slice("ytsearch:".length);
  }

  return sourceUrl;
};

const enqueueSource = (
  channelId: number,
  sourceUrl: string,
  invokerUserId: number,
): number => {
  const state = getState(channelId);

  state.queue.push({ sourceUrl, invokerUserId });

  return state.queue.length;
};

const takeNextFromQueue = (channelId: number): TQueueItem | null => {
  const state = getState(channelId);

  return state.queue.shift() ?? null;
};

const removeQueueItem = (
  channelId: number,
  position: number,
): TQueueItem | null => {
  const state = getState(channelId);
  const queueIndex = position - 1;

  if (
    !Number.isInteger(position) ||
    queueIndex < 0 ||
    queueIndex >= state.queue.length
  ) {
    return null;
  }

  const [removedItem] = state.queue.splice(queueIndex, 1);

  return removedItem ?? null;
};

const buildQueueEntries = (state: ChannelStreamState): PlayerQueueEntry[] =>
  state.queue.map((item, index) => ({
    position: index + 1,
    label: item.resolvedTrack?.title ?? formatSourceLabel(item.sourceUrl),
    invokerUserId: item.invokerUserId,
    isResolving: !item.resolvedTrack,
  }));

const emptyPlayerStateSnapshot = (): PlayerStateSnapshot => ({
  currentSong: null,
  currentInvokerUserId: null,
  currentThumbnailUrl: null,
  streamActive: false,
  streamStarting: false,
  playbackStartedAtEpochMs: null,
  currentTrackDurationSeconds: null,
  volume: DEFAULT_VOLUME,
  queue: [],
  autoplay: false,
});

const getPlayerStateSnapshot = (
  channelId?: number | null,
): PlayerStateSnapshot => {
  const state = channelId ? getExistingState(channelId) : undefined;

  if (!state) {
    return emptyPlayerStateSnapshot();
  }

  return {
    currentSong: state.currentSong,
    currentInvokerUserId: state.currentInvokerUserId,
    currentThumbnailUrl: state.currentThumbnailUrl,
    streamActive: state.streamActive,
    streamStarting: state.streamStarting,
    playbackStartedAtEpochMs: state.playbackStartedAtEpochMs,
    currentTrackDurationSeconds: state.currentTrackDurationSeconds,
    volume: state.volume,
    queue: buildQueueEntries(state),
    autoplay: state.autoplay,
  };
};

const recordPlayedVideo = (channelId: number, videoId: string): void => {
  const state = getState(channelId);
  state.lastPlayedVideoId = videoId;
  if (!state.recentVideoIds.includes(videoId)) {
    state.recentVideoIds.push(videoId);
    if (state.recentVideoIds.length > 50) {
      state.recentVideoIds.shift();
    }
  }
};

const getChannelIds = (): number[] => Array.from(channelStreams.keys());

const clearAllChannelStates = (): void => {
  channelStreams.clear();
};

export {
  clearAllChannelStates,
  DEFAULT_VOLUME,
  emptyPlayerStateSnapshot,
  enqueueSource,
  formatSourceLabel,
  getChannelIds,
  getExistingState,
  getPlayerStateSnapshot,
  getState,
  recordPlayedVideo,
  removeQueueItem,
  takeNextFromQueue,
};
export type { ChannelStreamState, TQueueItem };
