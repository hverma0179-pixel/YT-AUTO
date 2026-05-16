FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && command -v ffmpeg \
  && command -v python3 \
  && command -v yt-dlp \
  && ffmpeg -version \
  && yt-dlp --version \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=10000
ENV HOST=0.0.0.0
ENV FFMPEG_PATH=ffmpeg
ENV YTDLP_PATH=yt-dlp
ENV YTDLP_JS_RUNTIME=node:/usr/local/bin/node
ENV YTDLP_COOKIES_PATH=./cookies.txt
ENV YTDLP_VERBOSE=false
ENV SHORT_START=00:01:00
ENV SHORT_DURATION=45
ENV SHORT_WIDTH=720
ENV SHORT_HEIGHT=1280
ENV YTDLP_FORMAT=bv*[height<=1080]+ba/b[height<=1080]/best[height<=1080]
ENV FFMPEG_PRESET=veryfast
ENV FFMPEG_CRF=23
ENV AUDIO_BITRATE=192k
ENV YTDLP_MAX_HEIGHT=1080
ENV TRANSCRIPT_LANGS=en.*,en
ENV RENDER_TIMEOUT_MS=600000
ENV UPLOAD_CHUNK_SIZE=8388608
ENV UPLOAD_TIMEOUT_MS=600000
ENV MAX_SOURCE_DURATION_SECONDS=7200

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 10000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
