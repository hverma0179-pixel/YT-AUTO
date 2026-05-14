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
