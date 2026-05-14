# AutoShorts Studio

AutoShorts Studio is a zero-dependency Node app that lets a user sign in with Google, paste a YouTube long-form video URL, and schedule an automated short-form upload pipeline.

Important: only process videos you own or have clear rights to reuse. YouTube and copyright rules still apply.

## What It Does

- Google login with YouTube upload permissions.
- Dashboard that opens only after Google login.
- Saves a daily automation job for a pasted YouTube URL or a direct video file URL.
- Generates title, description, tags, and thumbnail text with an AI provider.
- Downloads and cuts a vertical short with `yt-dlp` and `ffmpeg`.
- Uploads the generated short to the signed-in user's YouTube channel.
- Generates a thumbnail image from the short and uploads it to YouTube.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill the blank values:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
   - `OPENROUTER_API_KEY`
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

## Security Notes

Never put API keys or OAuth secrets in frontend files. Keep them in `.env`.

If you pasted an API key into chat or any public place, rotate it from the provider dashboard before using this app.

## Production Notes

This is a local starter scaffold. Before using it for real users, replace the file-based JSON store with a database, encrypt tokens at rest, add job locking, validate ownership/rights more strictly, and move rendering jobs to a background worker.

## Source Video Reliability

Cloud providers can be rate-limited or blocked by YouTube when downloading videos with `yt-dlp`. If a YouTube URL fails with a bot check or HTTP 429, use a direct video file URL that you control, such as an `.mp4`, `.mov`, `.m4v`, or `.webm` file from your storage provider.

## YouTube Cookies Setup

YouTube may block server IPs with rate limits or bot checks. When that happens, `yt-dlp` can use a Netscape-format `cookies.txt` file exported from a browser where you are signed in to YouTube.

Do not commit `cookies.txt` to GitHub. It can grant access to your YouTube session. This repo ignores it with `.gitignore`.

### Export cookies.txt

1. Open your normal browser and sign in to the YouTube account that is allowed to watch the source video.
2. Install a trusted cookies export browser extension that exports Netscape-format cookies, such as "Get cookies.txt LOCALLY".
3. Open `youtube.com` in that browser.
4. Export cookies for YouTube as `cookies.txt`.
5. Save the file locally next to `server.js` for local testing:

```text
cookies.txt
```

### Local env

Add this to `.env`:

```env
YTDLP_COOKIES_PATH=./cookies.txt
YTDLP_VERBOSE=false
```

For debugging, set:

```env
YTDLP_VERBOSE=true
```

When `YTDLP_VERBOSE=true`, the app adds `-vU` to the `yt-dlp` command.

### Render env

Set this environment variable on Render:

```env
YTDLP_COOKIES_PATH=./cookies.txt
```

Then make sure `cookies.txt` exists in the server's app root at runtime. Never upload `cookies.txt` to public GitHub.

On Render Docker services, the safer option is a Render Secret File. In the Render dashboard, open your service, go to **Environment**, then under **Secret Files** add:

```text
Filename: cookies.txt
Contents: paste the exported cookies.txt content
```

Render makes Docker secret files available at:

```text
/etc/secrets/cookies.txt
```

Then set:

```env
YTDLP_COOKIES_PATH=/etc/secrets/cookies.txt
YTDLP_VERBOSE=false
```

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
