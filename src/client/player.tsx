import { Button, Popover, PopoverContent, PopoverTrigger } from "@sharkord/ui";
import type { CSSProperties } from "react";
import { memo, useEffect, useRef, useState } from "react";
import {
  CloseIcon,
  InfinityIcon,
  LoaderIcon,
  MuteIcon,
  NoteIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  SearchIcon,
  SkipIcon,
  StopIcon,
  VideoIcon,
  VolumeIcon,
} from "./icons";
import { Queue } from "./queue";
import { callAction, useUserName } from "./store";
import { panelStyle } from "./styles";
import { formatDuration, usePlayer } from "./use-player";

type PlayerPanelProps = {
  controller: ReturnType<typeof usePlayer>;
};

const PlayerPanel = ({ controller }: PlayerPanelProps) => {
  const {
    can,
    elapsedSeconds,
    error,
    isBusy,
    jumpTo,
    pause,
    play,
    player,
    previous,
    progressPercent,
    remove,
    resume,
    seek,
    setVolume,
    skip,
    stop,
    toggleAutoplay,
    toggleVideo,
  } = controller;
  const [query, setQuery] = useState("");
  const [pendingQuery, setPendingQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const suggestionsCache = useRef<Map<string, string[]>>(new Map());

  // held locally while dragging, so the slider does not fight its own pushes
  const [volume, setVolumeDraft] = useState(player.volume);
  const volumeDebounceTimer = useRef<number | null>(null);

  const addedBy = useUserName(player.currentInvokerUserId);

  useEffect(() => setVolumeDraft(player.volume), [player.volume]);

  const handleVolumeChange = (newVolume: number) => {
    setVolumeDraft(newVolume);
    if (volumeDebounceTimer.current !== null) {
      window.clearTimeout(volumeDebounceTimer.current);
    }
    volumeDebounceTimer.current = window.setTimeout(() => {
      setVolume(newVolume);
    }, 80);
  };

  useEffect(() => {
    if (!isBusy && !player.streamStarting) {
      setPendingQuery("");
    }
  }, [isBusy, player.streamStarting]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!can.play || trimmed.length <= 2 || /^https?:\/\//.test(trimmed)) {
      setSuggestions([]);
      setShowSuggestions(false);
      setSelectedIndex(-1);
      return;
    }

    const cacheKey = trimmed.toLowerCase();
    const cached = suggestionsCache.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      setShowSuggestions(cached.length > 0);
      setSelectedIndex(-1);
      return;
    }

    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const results = await callAction("getSearchSuggestions", { query: trimmed });
        if (active) {
          suggestionsCache.current.set(cacheKey, results);
          setSuggestions(results);
          setShowSuggestions(results.length > 0);
          setSelectedIndex(-1);
        }
      } catch {
        if (active) {
          setSuggestions([]);
          setShowSuggestions(false);
          setSelectedIndex(-1);
        }
      }
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, can.play]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const isPlaying = player.streamActive;
  const isLoading =
    !isPlaying && (player.streamStarting || (isBusy && player.queue.length === 0));
  const canSubmit = query.trim() !== "" && !isBusy && can.play;

  const submit = (overrideQuery?: string) => {
    const target = (overrideQuery ?? query).trim();
    if (!target || isBusy || !can.play) return;

    if (!isPlaying) {
      setPendingQuery(target);
    }
    play(target);
    setQuery("");
    setShowSuggestions(false);
    setSelectedIndex(-1);
  };

  const title = isPlaying
    ? (player.currentSong ?? "Unknown track")
    : isLoading
      ? (pendingQuery || "Starting playback...")
      : "Nothing playing";

  const canSeek =
    isPlaying &&
    !isBusy &&
    Boolean(can.seek) &&
    player.currentTrackDurationSeconds !== null &&
    player.currentTrackDurationSeconds > 0;

  const [isDragging, setIsDragging] = useState(false);
  const [draftPercent, setDraftPercent] = useState<number | null>(null);
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);
  const barTrackRef = useRef<HTMLDivElement>(null);

  const getPercentFromPointer = (e: React.PointerEvent) => {
    if (!barTrackRef.current) return 0;
    const rect = barTrackRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    return (x / rect.width) * 100;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!canSeek || !player.currentTrackDurationSeconds) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    setDraftPercent(getPercentFromPointer(e));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging) {
      setDraftPercent(getPercentFromPointer(e));
    } else if (canSeek) {
      setHoverPercent(getPercentFromPointer(e));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const finalPercent = getPercentFromPointer(e);
    setDraftPercent(null);
    if (player.currentTrackDurationSeconds) {
      const targetSec = (finalPercent / 100) * player.currentTrackDurationSeconds;
      seek(targetSec);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!canSeek || !player.currentTrackDurationSeconds) return;
    const duration = player.currentTrackDurationSeconds;
    const current = elapsedSeconds ?? 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      seek(Math.max(0, current - 5));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      seek(Math.min(duration, current + 5));
    }
  };

  const displayedPercent =
    isDragging && draftPercent !== null ? draftPercent : progressPercent;

  const displayedElapsedSeconds =
    isDragging && draftPercent !== null && player.currentTrackDurationSeconds
      ? Math.round((draftPercent / 100) * player.currentTrackDurationSeconds)
      : elapsedSeconds;

  return (
    <div className="mb-panel">
      <div className="mb-search" ref={searchContainerRef}>
        <div className="mb-search-field">
          <SearchIcon />
          <input
            className="mb-search-input"
            value={query}
            placeholder="Search or paste a link"
            aria-label="Search or paste a link"
            disabled={!can.play}
            onFocus={() => {
              if (suggestions.length > 0) setShowSuggestions(true);
            }}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (showSuggestions && suggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedIndex((prev) =>
                    prev < suggestions.length - 1 ? prev + 1 : 0
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedIndex((prev) =>
                    prev > 0 ? prev - 1 : suggestions.length - 1
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setShowSuggestions(false);
                  return;
                }
                if (event.key === "Enter" && selectedIndex >= 0) {
                  event.preventDefault();
                  submit(suggestions[selectedIndex]);
                  return;
                }
              }

              if (event.key !== "Enter") return;

              event.preventDefault();
              submit();
            }}
          />
        </div>

        <button
          type="button"
          className="mb-add"
          disabled={(!canSubmit && !isBusy) || isBusy}
          onClick={() => submit()}
        >
          {isBusy ? (
            <span className="mb-btn-loading">
              <LoaderIcon size={14} />
              <span>{isPlaying ? "Adding..." : "Fetching..."}</span>
            </span>
          ) : isPlaying || isLoading ? (
            "Queue"
          ) : (
            "Play"
          )}
        </button>

        {showSuggestions && suggestions.length > 0 && (
          <div className="mb-suggestions" role="listbox">
            {suggestions.map((item, index) => (
              <button
                key={item}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`mb-suggestion-item ${
                  index === selectedIndex ? "mb-suggestion-active" : ""
                }`}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit(item);
                }}
              >
                <SearchIcon size={14} className="mb-suggestion-icon" />
                <span className="mb-suggestion-text">{item}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mb-hero">
        <div className="mb-art">
          {player.currentThumbnailUrl ? (
            <img src={player.currentThumbnailUrl} alt="" />
          ) : (
            <span
              className={`mb-art-fallback ${isLoading && !isPlaying ? "mb-art-loading" : ""}`}
            >
              {isLoading && !isPlaying ? (
                <LoaderIcon size={28} />
              ) : (
                <NoteIcon size={34} />
              )}
            </span>
          )}
        </div>

        <div>
          <div
            className={
              isPlaying
                ? "mb-eyebrow"
                : isLoading
                  ? "mb-eyebrow mb-eyebrow-loading"
                  : "mb-eyebrow mb-eyebrow-idle"
            }
          >
            {isPlaying
              ? player.isPaused
                ? "Paused"
                : "Now playing"
              : isLoading
                ? "Fetching song..."
                : "Idle"}
            {isPlaying && player.videoLabel ? (
              <span className="mb-badge" title="Streaming video">
                {player.videoLabel}
              </span>
            ) : null}
          </div>
          <div className="mb-title">
            {isLoading && !isPlaying ? (
              <span className="mb-title-loading">
                <LoaderIcon size={14} />
                <span>{title}</span>
              </span>
            ) : (
              title
            )}
          </div>
          <div className="mb-sub">
            {!can.play
              ? "You cannot control the player"
              : isPlaying
                ? addedBy
                  ? `Added by ${addedBy}`
                  : "Playing"
                : isLoading
                  ? "Connecting to audio stream..."
                  : "Search above to start the queue"}
          </div>
        </div>
      </div>

      <div className="mb-progress">
        <div
          ref={barTrackRef}
          className={`mb-bar-track ${canSeek ? "mb-interactive" : ""} ${isDragging ? "mb-dragging" : ""}`}
          role="slider"
          tabIndex={canSeek ? 0 : -1}
          aria-valuenow={displayedElapsedSeconds ?? 0}
          aria-valuemin={0}
          aria-valuemax={player.currentTrackDurationSeconds ?? 0}
          aria-label="Playback timeline"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => setHoverPercent(null)}
          onKeyDown={handleKeyDown}
        >
          <div className="mb-bar">
            <div
              className="mb-bar-fill"
              style={{ width: `${displayedPercent}%` }}
            >
              {canSeek ? <span className="mb-bar-thumb" /> : null}
            </div>
            {hoverPercent !== null && canSeek && player.currentTrackDurationSeconds ? (
              <div
                className="mb-bar-tooltip"
                style={{ left: `${hoverPercent}%` }}
              >
                {formatDuration(
                  (hoverPercent / 100) * player.currentTrackDurationSeconds,
                )}
              </div>
            ) : null}
          </div>
        </div>
        <div className="mb-times">
          <span>{formatDuration(displayedElapsedSeconds)}</span>
          <span>{formatDuration(player.currentTrackDurationSeconds)}</span>
        </div>
      </div>

      <div className="mb-controls">
        <div className="mb-toggles">
        <button
          type="button"
          role="switch"
          aria-checked={player.autoplay}
          className={`mb-autoplay-toggle ${player.autoplay ? "mb-autoplay-active" : ""}`}
          title={
            player.autoplay
              ? "Autoplay enabled (YouTube Mix)"
              : "Autoplay disabled"
          }
          aria-label="Toggle autoplay"
          disabled={isBusy || !can.autoplay}
          onClick={toggleAutoplay}
        >
          <span
            className={`mb-switch-track ${player.autoplay ? "mb-switch-active" : ""}`}
          >
            <span className="mb-switch-thumb" />
          </span>
          <span className="mb-autoplay-icon">
            <InfinityIcon size={14} />
          </span>
          <span>Autoplay</span>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={player.videoEnabled}
          className={`mb-autoplay-toggle ${player.videoEnabled ? "mb-autoplay-active" : ""}`}
          title={
            player.videoEnabled
              ? "Video on: YouTube video is streamed with the audio (applies from the next track)"
              : "Video off: audio only (applies from the next track)"
          }
          aria-label="Toggle video"
          disabled={isBusy || !can.video}
          onClick={toggleVideo}
        >
          <span
            className={`mb-switch-track ${player.videoEnabled ? "mb-switch-active" : ""}`}
          >
            <span className="mb-switch-thumb" />
          </span>
          <span className="mb-autoplay-icon">
            <VideoIcon size={14} />
          </span>
          <span>Video</span>
        </button>
        </div>

        <div className="mb-transport">
          <button
            type="button"
            className="mb-ctrl"
            title="Stop playback"
            aria-label="Stop playback"
            disabled={isBusy || !isPlaying || !can.stop}
            onClick={stop}
          >
            <StopIcon size={18} />
          </button>

          <button
            type="button"
            className="mb-ctrl"
            title={
              (displayedElapsedSeconds ?? 0) > 3
                ? "Restart track"
                : "Previous track"
            }
            aria-label={
              (displayedElapsedSeconds ?? 0) > 3
                ? "Restart track"
                : "Previous track"
            }
            disabled={isBusy || !isPlaying || !can.previous}
            onClick={previous}
          >
            <PreviousIcon size={20} />
          </button>

          <button
            type="button"
            className="mb-ctrl mb-ctrl-main"
            title={
              player.isPaused
                ? "Resume playback"
                : isPlaying
                  ? "Pause playback"
                  : "Play"
            }
            aria-label={
              player.isPaused
                ? "Resume playback"
                : isPlaying
                  ? "Pause playback"
                  : "Play"
            }
            disabled={
              isBusy ||
              !isPlaying ||
              (player.isPaused ? !can.resume : !can.pause)
            }
            onClick={player.isPaused ? resume : pause}
          >
            {player.isPaused ? <PlayIcon size={22} /> : <PauseIcon size={20} />}
          </button>

          <button
            type="button"
            className="mb-ctrl"
            title="Skip to the next track"
            aria-label="Skip to the next track"
            disabled={
              isBusy || !can.skip || (!isPlaying && player.queue.length === 0)
            }
            onClick={skip}
          >
            <SkipIcon size={20} />
          </button>
        </div>

        <div className="mb-volume">
          {volume === 0 ? <MuteIcon /> : <VolumeIcon />}
          <input
            className="mb-volume-input"
            type="range"
            min={0}
            max={100}
            value={volume}
            style={{ "--mb-volume": `${volume}%` } as CSSProperties}
            aria-label="Master volume"
            title={`Master volume: ${volume}%`}
            disabled={!can.volume}
            onChange={(event) => handleVolumeChange(Number(event.target.value))}
            onPointerUp={() => {
              if (volumeDebounceTimer.current !== null) {
                window.clearTimeout(volumeDebounceTimer.current);
              }
              setVolume(volume);
            }}
            onKeyUp={() => setVolume(volume)}
          />
        </div>
      </div>

      {error ? <div className="mb-note">{error}</div> : null}

      {player.queue.length > 0 ? (
        <Queue
          queue={player.queue}
          isBusy={isBusy}
          canJump={can.jump}
          canRemove={can.remove}
          onJump={jumpTo}
          onRemove={remove}
        />
      ) : (
        <div className="mb-empty">The queue is empty.</div>
      )}
    </div>
  );
};

const Player = memo(() => {
  const [open, setOpen] = useState(false);
  const controller = usePlayer();

  // every control needs a voice channel to act on, so out of one there is
  // nothing the panel could do: the whole button goes away
  if (controller.isDisconnected) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Music player"
          style={{ position: "relative" }}
        >
          <NoteIcon size={20} />
          {controller.player.streamActive ? <span className="mb-dot" /> : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" style={panelStyle}>
        <PlayerPanel controller={controller} />
      </PopoverContent>
    </Popover>
  );
});

export { Player };
