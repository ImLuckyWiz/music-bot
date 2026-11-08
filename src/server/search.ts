type TSearchOptions = {
  proxy?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
  error?: (message: string, error?: unknown) => void;
};

const DEFAULT_TIMEOUT_MS = 4000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const parseYtMusicSongVideoId = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null;

  const sections = (data as Record<string, any>)?.contents
    ?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.sectionListRenderer?.contents;

  if (!Array.isArray(sections)) return null;

  for (const section of sections) {
    const shelf = section?.musicShelfRenderer;
    if (Array.isArray(shelf?.contents)) {
      for (const item of shelf.contents) {
        const videoId =
          item?.musicResponsiveListItemRenderer?.playlistItemData?.videoId;
        if (typeof videoId === "string" && videoId.length === 11) {
          return videoId;
        }
      }
    }
  }

  return null;
};

const parseYtWebVideoId = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null;

  const sections = (data as Record<string, any>)?.contents
    ?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
    ?.contents;

  if (!Array.isArray(sections)) return null;

  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents;
    if (Array.isArray(items)) {
      for (const item of items) {
        const videoId =
          item?.videoRenderer?.videoId ?? item?.compactVideoRenderer?.videoId;
        if (typeof videoId === "string" && videoId.length === 11) {
          return videoId;
        }

        const lockup = item?.lockupViewModel;
        if (
          lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" &&
          typeof lockup?.contentId === "string" &&
          lockup.contentId.length === 11
        ) {
          return lockup.contentId;
        }
      }
    }
  }

  return null;
};

/**
 * Searches YouTube Music for official audio tracks/songs using the public InnerTube API.
 * Uses the Songs shelf filter (`EgWKAQIIAWoQEAUQAxAEEAkQChAKEAkQCQ==`) to prioritize
 * studio audio / Topic tracks over music videos.
 */
export const searchYouTubeMusicSong = async (
  query: string,
  options?: TSearchOptions,
): Promise<string | null> => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const res = await fetch("https://music.youtube.com/youtubei/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: "1.20240101.01.00",
            hl: "en",
            gl: "US",
          },
        },
        query,
        params: "EgWKAQIIAWoQEAUQAxAEEAkQChAKEAkQCQ==",
      }),
      signal: AbortSignal.timeout(timeoutMs),
      ...(options?.proxy ? { proxy: options.proxy } : {}),
    });

    if (!res.ok) {
      options?.log?.(
        `[search] YouTube Music returned HTTP ${res.status} for query: ${query}`,
      );
      return null;
    }

    const data = await res.json();
    return parseYtMusicSongVideoId(data);
  } catch (err) {
    options?.error?.(
      `[search] YouTube Music search failed for "${query}":`,
      err,
    );
    return null;
  }
};

/**
 * Searches standard YouTube for top video results using the public InnerTube API.
 * Prioritizes official videos/music videos when video playback is enabled.
 */
export const searchYouTubeWebVideo = async (
  query: string,
  options?: TSearchOptions,
): Promise<string | null> => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240101.01.00",
            hl: "en",
            gl: "US",
          },
        },
        query,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      ...(options?.proxy ? { proxy: options.proxy } : {}),
    });

    if (!res.ok) {
      options?.log?.(
        `[search] YouTube Web returned HTTP ${res.status} for query: ${query}`,
      );
      return null;
    }

    const data = await res.json();
    return parseYtWebVideoId(data);
  } catch (err) {
    options?.error?.(`[search] YouTube Web search failed for "${query}":`, err);
    return null;
  }
};

/**
 * Resolves a user input string into a playable URL.
 * - If already a direct HTTP/HTTPS URL, returns it unmodified.
 * - If videoEnabled is false (audio-only mode), searches YouTube Music for studio audio tracks.
 * - If videoEnabled is true (video mode), searches standard YouTube for official videos.
 * - If InnerTube search fails or times out, safely falls back to `ytsearch:<query>`.
 */
export const resolvePlayableSource = async (
  query: string,
  videoEnabled: boolean,
  options?: TSearchOptions,
): Promise<string> => {
  const trimmed = query.trim();

  if (!trimmed) {
    throw new Error("You must provide a search query or URL.");
  }

  if (/^https?:\/\//.test(trimmed)) {
    return trimmed;
  }

  const mode = videoEnabled ? "video" : "audio (YouTube Music)";
  options?.log?.(`[search] Resolving "${trimmed}" in ${mode} mode...`);

  const videoId = videoEnabled
    ? await searchYouTubeWebVideo(trimmed, options)
    : await searchYouTubeMusicSong(trimmed, options);

  if (videoId) {
    const resolvedUrl = `https://www.youtube.com/watch?v=${videoId}`;
    options?.log?.(
      `[search] Resolved "${trimmed}" -> ${resolvedUrl} (${mode})`,
    );
    return resolvedUrl;
  }

  options?.log?.(
    `[search] Direct InnerTube search yielded no results; falling back to ytsearch:${trimmed}`,
  );
  return `ytsearch:${trimmed}`;
};

export type TMusicRelatedTrack = {
  id: string;
  title: string;
  url: string;
};

/**
 * Fetches radio/autoplay recommendations from YouTube Music for a given seed track.
 * Uses the `RDAMVM<videoId>` radio playlist to return studio audio tracks (Topic tracks),
 * completely bypassing music videos with dialogue and skits.
 */
export const fetchYouTubeMusicRelatedTracks = async (
  seedVideoId: string,
  options?: TSearchOptions,
): Promise<TMusicRelatedTrack[]> => {
  const videoId = seedVideoId.trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return [];
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    options?.log?.(
      `[autoplay] Fetching YouTube Music radio recommendations for ${videoId}...`,
    );

    const res = await fetch("https://music.youtube.com/youtubei/v1/next", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: "1.20240101.01.00",
            hl: "en",
            gl: "US",
          },
        },
        videoId,
        playlistId: `RDAMVM${videoId}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      ...(options?.proxy ? { proxy: options.proxy } : {}),
    });

    if (!res.ok) {
      options?.log?.(
        `[autoplay] YouTube Music next returned HTTP ${res.status} for ${videoId}`,
      );
      return [];
    }

    const data = (await res.json()) as Record<string, any>;
    const tabs =
      data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs;
    const queueContent =
      tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content
        ?.playlistPanelRenderer?.contents;

    const tracks: TMusicRelatedTrack[] = [];
    if (Array.isArray(queueContent)) {
      for (const item of queueContent) {
        const r = item?.playlistPanelVideoRenderer;
        const vid = r?.videoId;
        if (
          typeof vid === "string" &&
          vid.length === 11 &&
          vid !== videoId
        ) {
          const title = r?.title?.runs?.[0]?.text ?? `Track ${vid}`;
          tracks.push({
            id: vid,
            title,
            url: `https://www.youtube.com/watch?v=${vid}`,
          });
        }
      }
    }

    options?.log?.(
      `[autoplay] Found ${tracks.length} YouTube Music radio tracks for ${videoId}`,
    );
    return tracks;
  } catch (err) {
    options?.error?.(
      `[autoplay] Failed to fetch YouTube Music radio tracks for ${videoId}:`,
      err,
    );
    return [];
  }
};

export type { TSearchOptions };
