import type { TVideoCodec } from "./yt-dlp";

type TSupportedVideoCodec = Exclude<TVideoCodec, "unsupported">;

const H264_PAYLOAD_TYPE = 102;
const VP9_PAYLOAD_TYPE = 103;

const MAX_RESOLUTIONS = [720, 1080, 1440] as const;
const DEFAULT_MAX_RESOLUTION = 1080;

const VIDEO_RTCP_FEEDBACK = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "goog-remb" },
];

const getVideoPayloadType = (codec: TSupportedVideoCodec): number =>
  codec === "vp9" ? VP9_PAYLOAD_TYPE : H264_PAYLOAD_TYPE;

const buildVideoRtpCodecs = (codec: TSupportedVideoCodec) =>
  codec === "vp9"
    ? [
        {
          mimeType: "video/VP9",
          payloadType: VP9_PAYLOAD_TYPE,
          clockRate: 90000,
          parameters: { "profile-id": 0 },
          rtcpFeedback: VIDEO_RTCP_FEEDBACK,
        },
      ]
    : [
        {
          mimeType: "video/H264",
          payloadType: H264_PAYLOAD_TYPE,
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1,
          },
          rtcpFeedback: VIDEO_RTCP_FEEDBACK,
        },
      ];

/** accepts "1080p", "1080" or " 720P "; anything else falls back to 1080 */
const parseMaxResolution = (raw: unknown): number => {
  const match = String(raw ?? "").match(/\d{3,4}/);
  const value = match ? Number(match[0]) : NaN;

  return (MAX_RESOLUTIONS as readonly number[]).includes(value)
    ? value
    : DEFAULT_MAX_RESOLUTION;
};

const parseBooleanSetting = (raw: unknown, fallback: boolean): boolean => {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;

  return fallback;
};

/** e.g. "1080p VP9", shown as a badge in the player */
const formatVideoLabel = (
  height: number | undefined,
  codec: TSupportedVideoCodec,
): string => {
  const codecLabel = codec === "vp9" ? "VP9" : "H.264";

  return height ? `${height}p ${codecLabel}` : codecLabel;
};

export {
  buildVideoRtpCodecs,
  DEFAULT_MAX_RESOLUTION,
  formatVideoLabel,
  getVideoPayloadType,
  MAX_RESOLUTIONS,
  parseBooleanSetting,
  parseMaxResolution,
};
export type { TSupportedVideoCodec };
