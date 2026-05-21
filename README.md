# AutoShorts Studio

AutoShorts Studio is a zero-dependency Node app that lets a user sign in with Google, paste a YouTube long-form video URL, and schedule an automated short-form upload pipeline. It also includes an Instagram login/theme scaffold for future Reels publishing.

Important: only process videos you own or have clear rights to reuse. YouTube and copyright rules still apply.

## What It Does

- Google login with YouTube upload permissions.
- Instagram login option with pink/blue Reels UI theme scaffold.
- Dashboard that opens only after Google login.
- Saves a daily automation job for a pasted YouTube URL or a direct video file URL.
- Uses transcript/captions when available so AI can pick the best 30-45 second moment and create unique title, description, tags, and thumbnail text.
- Downloads a Shorts-friendly source, cuts the selected short segment first, then renders only that clip with `yt-dlp` and `ffmpeg`.
- Uploads the generated short to the signed-in user's YouTube channel.
- Generates a thumbnail image from the short and uploads it to YouTube.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill the blank values:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
   - Optional Instagram scaffold values: `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`, `INSTAGRAM_REDIRECT_URI`
   - `OPENROUTER_API_KEY`
   - `SESSION_MAX_AGE_SECONDS` controls how long Google login stays active. Default is 90 days.
   - `SESSION_TOUCH_INTERVAL_MS` controls how often active sessions refresh. Default is 12 hours.
3. Install command-line tools used by the video pipeline:
   - `yt-dlp`
   - `ffmpeg`
4. Run:

```bash
node server.js
```

5. Open:

```text
http://localhost:4173
```

## Google Cloud Setup

Create an OAuth app in Google Cloud Console and add this redirect URI:

```text
http://localhost:4173/auth/callback
```

Enable the YouTube Data API v3 for the project.

The app requests these scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/youtube.upload`
- `https://www.googleapis.com/auth/youtube.force-ssl`

## Instagram Login / Reels Notes

The login page includes **Continue with Instagram** and switches the app into a pink/blue Instagram theme after Instagram login.

Set these values when you have a Meta app:

```env
INSTAGRAM_CLIENT_ID=
INSTAGRAM_CLIENT_SECRET=
INSTAGRAM_REDIRECT_URI=https://your-render-url.onrender.com/auth/instagram/callback
INSTAGRAM_SCOPES=instagram_business_basic,instagram_business_content_publish
INSTAGRAM_GRAPH_BASE_URL=https://graph.instagram.com/v24.0
INSTAGRAM_PROCESSING_ATTEMPTS=30
INSTAGRAM_PROCESSING_DELAY_MS=10000
```

Automatic Instagram Reel publishing is controlled by Meta's official API and requires approved publishing permissions. When Instagram is connected, the app uses the same rendered MP4 and caption metadata, exposes the MP4 from `/public/generated/`, creates a Reel media container, waits for Instagram processing, and publishes the Reel.

For Instagram uploads, `APP_BASE_URL` must be your public HTTPS Render URL so Meta can fetch the rendered MP4:

```env
APP_BASE_URL=https://your-render-url.onrender.com
```

Rendered Instagram media files are kept out of Git by `.gitignore`.

## Security Notes

Never put API keys or OAuth secrets in frontend files. Keep them in `.env`.

If you pasted an API key into chat or any public place, rotate it from the provider dashboard before using this app.

## Production Notes

This is a local starter scaffold. Before using it for real users, replace the file-based JSON store with a database, encrypt tokens at rest, add job locking, validate ownership/rights more strictly, and move rendering jobs to a background worker.

## Fast Shorts Processing

The app is optimized to avoid rendering an entire long source video. It now:

1. Downloads only the selected YouTube section with `yt-dlp --download-sections` and the `ffmpeg` downloader after manual, AI, or fallback timing is selected.
2. If no timing is entered, checks YouTube transcript/captions when available.
3. Asks AI to pick the strongest 30-45 second moment and create unique metadata.
4. Falls back to `SHORT_START` and `SHORT_DURATION` when transcript or AI fails.
5. Cuts only the selected short clip.
6. Renders only that clip to vertical Shorts format with a Vivid Warm filter.
7. Uploads the final short with YouTube resumable upload chunks.

Default fast-processing env values:

```env
SHORT_START=00:01:00
SHORT_DURATION=45
SHORT_WIDTH=1080
SHORT_HEIGHT=1920
YTDLP_FORMAT=bv*[height>=1080][height<=2160]+ba/b[height>=1080][height<=2160]/bv*[height<=1080]+ba/b[height<=1080]/best
YTDLP_FORMAT_SORT=res:2160,fps,ext:mp4:m4a
FFMPEG_PRESET=medium
FFMPEG_CRF=16
FFMPEG_MAXRATE=24M
FFMPEG_BUFSIZE=48M
AUDIO_BITRATE=320k
YTDLP_MAX_HEIGHT=2160
TRANSCRIPT_LANGS=en.*,en
RENDER_TIMEOUT_MS=1800000
MIN_RENDER_TIMEOUT_MS=1200000
UPLOAD_CHUNK_SIZE=8388608
UPLOAD_TIMEOUT_MS=600000
MAX_SOURCE_DURATION_SECONDS=7200
```

The default yt-dlp source format avoids low-quality 360p/480p video and prefers 1080p-2160p source when available before the final Shorts render:

```text
bv*[height>=1080][height<=2160]+ba/b[height>=1080][height<=2160]/bv*[height<=1080]+ba/b[height<=1080]/best
```

The default ffmpeg render target is 1080x1920 with `libx264`, `medium`, `crf 18`, `maxrate 16M`, `bufsize 32M`, `high` profile, `yuv420p`, AAC audio at 192k, `+faststart`, and this sharpened Vivid Warm filter:

```text
scale=1080:1920:flags=lanczos:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,unsharp=5:5:1.0:3:3:0.6,eq=saturation=1.16:contrast=1.06:brightness=0.01
```

The job logs now show whether a manual timeline was used, transcript status, the AI-selected timestamp, generated title, generated description, selected yt-dlp format, source resolution, selected-section download, Vivid Warm filtering, ffmpeg CRF, final output resolution, final file size, and whether fallback was used.

Auto titles use the original yt-dlp metadata:

```text
{original video title} own by {channel name} le edits
```

## Source Video Reliability

Cloud providers can be rate-limited or blocked by YouTube when downloading videos with `yt-dlp`. If a YouTube URL fails with a bot check or HTTP 429, use a direct video file URL that you control, such as an `.mp4`, `.mov`, `.m4v`, or `.webm` file from your storage provider.

## YouTube Cookies Setup

YouTube may block server IPs with rate limits or bot checks. When that happens, `yt-dlp` can use a Netscape-format `cookies.txt` file exported from a browser where you are signed in to YouTube. YouTube controls when browser cookies expire or get rejected, so no app can make one cookie file valid forever. This app reduces cookie failures by copying a fresh writable cookie file for every `yt-dlp` run and by rotating through backup cookie files when configured.

Do not commit `cookies.txt` to GitHub. It can grant access to your YouTube session. This repo ignores it with `.gitignore`.

### Export cookies.txt

1. Open your normal browser and sign in to the YouTube account that is allowed to watch the source video.
2. Install a trusted cookies export browser extension that exports Netscape-format cookies, such as "Get cookies.txt LOCALLY".
3. Open `youtube.com` in that browser.
4. Export cookies for YouTube as `cookies.txt`.
5. Alternative advanced method: run `yt-dlp --cookies-from-browser chrome --cookies cookies.txt "https://www.youtube.com"` on your own computer.
6. Save the file locally next to `server.js` for local testing:

```text
cookies.txt
```

### Local env

Add this to `.env`:

```env
YTDLP_COOKIES_PATH=./cookies.txt
YTDLP_COOKIES_PATHS=./cookies.txt
YTDLP_VERBOSE=false
```

For debugging, set:

```env
YTDLP_VERBOSE=true
```

When `YTDLP_VERBOSE=true`, the app adds `-vU` to the `yt-dlp` command.

### Render env

For Render, use a Secret File instead of committing cookies to GitHub. In the Render dashboard, open your service, go to **Environment**, then under **Secret Files** add:

```text
Filename: cookies.txt
Contents: paste the exported cookies.txt content
```

Render makes Docker secret files available at:

```text
/etc/secrets/cookies.txt
```

Set this environment variable on Render:

```env
YTDLP_COOKIES_PATH=/etc/secrets/cookies.txt
YTDLP_COOKIES_PATHS=/etc/secrets/cookies.txt
YTDLP_VERBOSE=false
```

Redeploy after updating the secret file so the service reads the latest cookies.

Optional backup cookies: create more Render Secret Files, for example `cookies-2.txt` and `cookies-3.txt`, then set:

```env
YTDLP_COOKIES_PATHS=/etc/secrets/cookies.txt,/etc/secrets/cookies-2.txt,/etc/secrets/cookies-3.txt
```

If YouTube rejects one cookie file during metadata, transcript, or download, the app tries the next configured cookie file.

The app never passes `/etc/secrets/cookies.txt` directly to `yt-dlp`. It validates the secret file first, then copies a fresh writable copy for each job/run to:

```text
/tmp/autoshorts-work/<job-id>/cookies.txt
```

Only the per-job temp cookie file is passed to `yt-dlp`, which avoids Render's read-only secret-file mount error, avoids shared `/tmp/cookies.txt` corruption between jobs, and keeps the original secret file unchanged. The temp copy is recreated before each `yt-dlp` command.

Cookie validation checks:

```text
file exists
file size is greater than 0
youtube.com cookies are present
login cookies such as SID, HSID, SAPISID, LOGIN_INFO, or secure PSID are present
```

If validation fails, the job fails clearly with:

```text
Cookies expired/invalid. Upload fresh cookies.txt in Render Secret File.
```

If YouTube rejects all configured cookies during `yt-dlp`, the job fails clearly with:

```text
Cookies expired/invalid. Upload fresh cookies.txt in Render Secret File.
```

Job logs include the cookies source path, temp path, validation result, and exact cookie-related `yt-dlp` failure when available.

If you prefer a persistent disk, place `cookies.txt` on that disk and point `YTDLP_COOKIES_PATH` to that file. For example, with a disk mounted at:

```text
/var/data
```

you can use:

```env
YTDLP_COOKIES_PATH=/var/data/cookies.txt
```

### yt-dlp reliability options

For YouTube URLs, the app now automatically adds:

```text
--sleep-requests 8
--sleep-interval 8
--max-sleep-interval 20
--retries 10
--fragment-retries 10
--no-playlist
--force-ipv4
```

If `cookies.txt` exists at `YTDLP_COOKIES_PATH`, the app also adds:

```text
--cookies path/to/cookies.txt
```
