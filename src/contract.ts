type PlayerQueueEntry = {
  position: number;
  label: string;
  invokerUserId: number;
  isResolving?: boolean;
};

type PlayerStateSnapshot = {
  currentSong: string | null;
  currentInvokerUserId: number | null;
  currentThumbnailUrl: string | null;
  /** e.g. "1080p VP9"; null when the track is audio only */
  videoLabel: string | null;
  streamActive: boolean;
  streamStarting: boolean;
  playbackStartedAtEpochMs: number | null;
  currentTrackDurationSeconds: number | null;
  volume: number;
  queue: PlayerQueueEntry[];
  autoplay: boolean;
};

type PlayerActionResponse = {
  message: string;
  player: PlayerStateSnapshot;
};

type TSharkord = {
  actions: {
    getPlayerState: {
      payload: void;
      response: PlayerStateSnapshot;
    };
    playMusic: {
      payload: { query: string };
      response: PlayerActionResponse;
    };
    removeQueueItem: {
      payload: { position: number };
      response: PlayerActionResponse;
    };
    nextMusic: {
      payload: void;
      response: PlayerActionResponse;
    };
    jumpToQueueItem: {
      payload: { position: number };
      response: PlayerActionResponse;
    };
    stopMusic: {
      payload: void;
      response: PlayerActionResponse;
    };
    setVolume: {
      payload: { volume: number };
      response: PlayerActionResponse;
    };
    toggleAutoplay: {
      payload: void;
      response: PlayerActionResponse;
    };
    getSearchSuggestions: {
      payload: { query: string };
      response: string[];
    };
  };
  commands: {
    "update-ffmpeg": {
      args: void;
      response: string;
    };
    "update-yt-dlp": {
      args: void;
      response: string;
    };
  };
  push: {
    channelId: number;
    player: PlayerStateSnapshot;
  };
};

export type {
  PlayerActionResponse,
  PlayerQueueEntry,
  PlayerStateSnapshot,
  TSharkord,
};
