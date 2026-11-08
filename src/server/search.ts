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

export type { TSearchOptions };
