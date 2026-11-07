# Music Bot

Music bot plugin for Sharkord that streams audio from YouTube or direct links
into a voice channel, and the video of YouTube links as a native stream tile.
Built against **plugin SDK v2**.

## Video streaming

For YouTube links the bot asks yt-dlp for separate video and audio streams
(H.264 first, VP9 as the alternative, up to the configured max resolution) and
forwards the video with ffmpeg stream copy (`-c:v copy`), so the server does no
video transcoding. Audio is still encoded to Opus. The matching WebRTC producer
(H.264 or VP9) is created per track, and the player shows a badge such as
`1080p VP9` while video is streaming.

Sources without a usable video stream (SoundCloud, direct audio links, AV1-only
videos) fall back to audio only, as does a track whose video producer the voice
router rejects.

## Dependencies

The plugin downloads what it needs (yt-dlp and ffmpeg) on first run, into its
data directory (`<data-dir>/plugin-data/music-bot/bin`). That directory survives
plugin updates, so the binaries are only fetched once.

yt-dlp comes from the [nightly builds](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases),
which track YouTube's extractor changes far more closely than the stable
releases do. Pull a newer one at any time with `/update-yt-dlp`.

## Manual Installation

1. Download the latest release from the [Releases](https://github.com/Sharkord/music-bot/releases) page.
2. Move the `music-bot` folder to your Sharkord plugins directory, typically located at `~/.config/sharkord/plugins`. See: [Data Dir](https://sharkord.com/docs/data-dir).

## Usage

Open the music player from the note icon in the top bar while you are connected
to a voice channel:

- **Search or paste a link** — plays it when the channel is idle, queues it when
  something is already on.
- **Stop** — stops playback and clears the channel's playback state.
- **Skip** — moves to the next queued track.
- **Volume** — the master level everyone hears. ffmpeg bakes the level in when
  a track starts, so a change applies from the next track on. To change what
  *you* hear right now, use the volume control on the stream's card in the
  voice channel, which Sharkord provides per listener.
- Hover a queue row to play it immediately or drop it from the queue.

## Permissions

Access is the host's, not the plugin's: every action requires
`JOIN_VOICE_CHANNELS` by default, and the player button is only shown to roles
that hold it. A server owner narrows either of those per role under the plugin's
permissions, without touching plugin settings.

The panel reads that back through `useCanUseAction`, so a control the user is
not allowed to use is disabled rather than failing on click. The server checks
again on every call — the disabled state is UI, not the boundary.

## Commands

Both require `MANAGE_PLUGINS`, and both answer immediately and keep downloading
in the background — follow the progress in the plugin's Logs tab.

- `/update-yt-dlp` — fetches the latest nightly yt-dlp build.
- `/update-ffmpeg` — fetches the latest ffmpeg build.

The new binary is moved into place once it is fully downloaded, so a failed
download leaves the working one untouched and playback is not interrupted.

## Settings

- **Bitrate** — the audio bitrate for the stream (default `128k`).
- **Stream Video** — stream the video of YouTube links (default on). Turn it
  off for audio only.
- **Max Resolution** — `480p`, `720p`, `1080p` or `1440p` (default `720p`). Anything
  above 1080p is VP9 only. Applies from the next track on.
- **Limit to 30 fps** — prefer 30 fps or lower video (default on). Video is
  copied untouched, so 60 fps roughly doubles bandwidth and stutter risk.
- **Input Buffer** — experimental, off by default. Reads ahead about 4 MB from
  YouTube, but on some servers a TLS reset during a reconnect ends the track.
- **Proxy URL** — optional proxy for YouTube requests.

## Screenshots

![Screenshot of the music bot plugin](https://i.imgur.com/tElMrbn.png)

## Troubleshooting

### Sign in to confirm you're not a bot

Well, turns out this is a bot. If you encounter this issue, you can try the
following solutions:

1. Run `/update-yt-dlp` — the nightly build usually has the fix within a day.
2. Use a different IP address by connecting through a VPN or proxy.
3. Pass your cookies to yt-dlp by writing them to
   `<data-dir>/plugin-data/music-bot/bin/cookies.txt`.

## Development

Set `SHARKORD_PLUGINS_PATH` in `.env` and every `bun run build` lands straight in
your server's plugins directory.
