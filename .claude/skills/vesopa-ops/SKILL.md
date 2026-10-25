---
name: vesopa-ops
description: Vesopa Ltd operational toolkit — analyse client videos with the Gemini API, extract video frames with ffmpeg, and reach the live EPOS back-office server over SSH. Use when a task references a video in tasks/, needs frames pulled from an MP4, or needs to inspect/deploy the live backoffice.vesopaepos.com server.
---

# Vesopa ops toolkit

## Credentials

Secrets live in two gitignored files at the repo root (`.gitignore:28` →
`**/.env.*`):

- `.env.claude`: the main one. Server login, hostnames, pm2 names, DB names,
  Firebase, Gemini, DeepSeek, Kimi, Google Play keys. `tool/deploy_memberships.py`
  loads it itself (`load_env_claude()`), and most `tool/deploy_*.py` scripts
  import that, so prefer them over hand-made SSH.
- `.env.claude-tools`: an older copy that `scripts/vesopa_ssh.py` reads. It is the
  same file plus `VESOPA_SSH_HOST` (user@host), minus `GoogleCloudPlayDeveloperAPIKey`.
  Keep the two in step when a key changes.

The owner runs PowerShell. To load the `VESOPA_*` values there:

```powershell
Get-Content .env.claude | ForEach-Object { if ($_ -match '^\s*(VESOPA_[A-Z0-9_]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2].Trim().Trim('"',"'") } }
```

In Git Bash: `set -a; . ./.env.claude; set +a`. Never echo the values into
command output, commit messages, or files that are not gitignored.

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

ffmpeg comes from the `imageio-ffmpeg` pip wheel, which is not installed on this
PC at the moment (`pip install imageio-ffmpeg`). Neither env file sets `$FFMPEG`;
get the path with:

```bash
FFMPEG=$(python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
"$FFMPEG" -i "tasks/Video 1.MP4" -vf fps=1 -q:v 3 out/frame_%03d.jpg   # 1 fps stills
"$FFMPEG" -i in.MP4 -ss 00:00:30 -t 30 -c copy out/segment.MP4          # 30s slice
```

Read the JPEGs back with the Read tool when you need to see exact UI detail that
a text description would blur.

## Live server

There are two boxes; the long comment at the top of `.env.claude` is the map.

- **Cloud box** (`VESOPA_SERVER_IP`): every Vesopa hostname and pontardawerfc.com
  point here. Hestia-managed: apps live in `/home/<user>/web/<domain>/private/nodeapp`
  and pm2 runs **per Hestia user** (`su - $VESOPA_CLOUD_APP_USER -c "pm2 ..."`).
  pm2 as root starts a second copy that fights for the port.
- **Legacy box** (`VESOPA_LEGACY_SERVER_IP`): still up, but no public traffic.
  `vesopa_server/deploy.sh`, `vesopa_web/deploy.sh` and `vesopa_hosting/deploy.sh`
  still target it, so a deploy through them changes nothing anyone sees. Don't use them.

How to deploy: use the Python tools in `tool/`, which load `.env.claude` and
target the Cloud box. Examples: `deploy_memberships.py --backoffice` (EPOS back
office), `deploy_pontardawe_site.py --site-only` (pontardawerfc.com),
`deploy_vesopaepos_site.py`, `vesopa_hosting/deploy-cloud.sh`. Run `--check`
first where a tool has one. Name the pm2 app every time (`$VESOPA_PM2_WEB`,
`$VESOPA_PM2_BACKOFFICE`, `$VESOPA_PM2_HOSTING`, `pontardawerfc.com`).
**Never `pm2 restart all`**: it takes the EPOS API and every site down together.

Windows has no sshpass; `scripts/vesopa_ssh.py` does password SSH and SFTP with paramiko:

```bash
python .claude/skills/vesopa-ops/scripts/vesopa_ssh.py run \
  "su - vesopasoftware -c 'pm2 logs pontardawerfc.com --lines 100 --nostream'"
```

Deploys from Git Bash have failed partway through an upload. The same command
run through PowerShell went through.

Deploys and any command that writes to the live database are outward-facing —
confirm with the user before running one.
