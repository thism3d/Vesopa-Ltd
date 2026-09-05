---
name: vesopa-ops
description: Vesopa Ltd operational toolkit — analyse client videos with the Gemini API, extract video frames with ffmpeg, and reach the live EPOS back-office server over SSH. Use when a task references a video in tasks/, needs frames pulled from an MP4, or needs to inspect/deploy the live backoffice.vesopaepos.com server.
---

# Vesopa ops toolkit

## Credentials

All secrets live in `.env.claude-tools` at the repo root. It is gitignored
(`.gitignore:28` → `**/.env.*`), so it never reaches a commit. Load it with:

```bash
set -a; . ./.env.claude-tools; set +a
```

Never echo these values into command output, commit messages, or files that are
not gitignored.

## Analysing a client video with Gemini

Client task videos live in `tasks/`. `scripts/gemini_video.py` uploads a video
through the Gemini Files API and asks a question about it — this handles both the
picture and the audio track, so voice notes work too.

```bash
set -a; . ./.env.claude-tools; set +a
python .claude/skills/vesopa-ops/scripts/gemini_video.py "tasks/Video 1.MP4" \
  "Describe every screen, tap and error message in order, with timestamps."
```

Files over ~18 MB or longer than a couple of minutes are better sliced first
(see below) and asked about a segment at a time.

## Pulling frames out of a video

ffmpeg comes from the `imageio-ffmpeg` pip wheel; `$FFMPEG` in the env file is
its absolute path.

```bash
"$FFMPEG" -i "tasks/Video 1.MP4" -vf fps=1 -q:v 3 out/frame_%03d.jpg   # 1 fps stills
"$FFMPEG" -i in.MP4 -ss 00:00:30 -t 30 -c copy out/segment.MP4          # 30s slice
```

Read the JPEGs back with the Read tool when you need to see exact UI detail that
a text description would blur.

## Live server

The back office runs under pm2 on `$VESOPA_SSH_HOST`. `vesopa_server/deploy.sh`
and `vesopa_web/deploy.sh` are the real deploy paths — read them before doing
anything by hand, and note their `LOCAL_APP` paths point at the original
author's Mac, so override them rather than assuming they are correct here.

```bash
set -a; . ./.env.claude-tools; set +a
sshpass -p "$VESOPA_SSH_PASSWORD" ssh -o StrictHostKeyChecking=accept-new \
  "$VESOPA_SSH_HOST" "pm2 logs $VESOPA_PM2_APP --lines 100 --nostream"
```

Deploys and any command that writes to the live database are outward-facing —
confirm with the user before running one.
