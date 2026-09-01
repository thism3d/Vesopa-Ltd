#!/usr/bin/env node
/* Two encodes of every backdrop clip, one per kind of device.
 *
 * The clips arrive from the generator as a single 1280px H.264 High-profile
 * file with the `moov` index written after the media, which is the worst
 * possible shape for the web:
 *
 *   - A player cannot start until it has read `moov`. With the index at the
 *     end, a browser must either fetch the whole file first or guess at a
 *     range request for the tail. On a phone on a slow line the clip simply
 *     never appears to load — which is exactly how this was reported, and it
 *     was reported about the later sections because those are the clips the
 *     generator happened to write index-last.
 *   - A 1280x720 High-profile clip is a lot of pixels and a lot of decoder for
 *     a 390px screen that is going to letterbox it behind a scrim anyway.
 *
 * So each source produces:
 *
 *   <slug>.lg.mp4   1280px, High profile, for anything with room for it
 *   <slug>.md.mp4   1024px, High profile, for tablets
 *   <slug>.sm.mp4    720px, Main profile,  for phones and metered lines
 *
 * The middle one exists because an iPad is neither of the other two. It has a
 * 2x display a metre from your face, where the 720px encode is visibly soft,
 * and it does not have a laptop's thermal headroom for the 1280px one behind
 * a live particle field. Serving it `sm` was the reason the backdrop looked
 * like a low-resolution smear on exactly the device most likely to be held
 * close enough to notice.
 *
 * Both are `+faststart`, both are silent, and both are `yuv420p`. Those three
 * are not tuning, they are the difference between playing and not:
 *
 *   faststart  the index in front, so playback starts on the first packets
 *   -an        these are muted backdrops; the audio track is bytes nobody will
 *              ever hear and an extra decoder on a device short of them
 *   yuv420p    the only chroma layout every hardware decoder is required to
 *              support; 4:2:2 or 10-bit plays on a desktop and fails silently
 *              on a phone
 *
 * Main rather than High on the small rendition for the same reason: it costs
 * almost nothing at this bitrate and it is what the oldest devices still in
 * use can decode without falling back to software.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const DIR = path.resolve("site/assets/video");

/** width, H.264 profile+level, quality, max bitrate. */
const RENDITIONS = [
  { name: "lg", width: 1280, profile: "high", level: "4.0", crf: 24, maxrate: "1400k", bufsize: "2800k" },
  { name: "md", width: 1024, profile: "high", level: "3.1", crf: 25, maxrate: "900k",  bufsize: "1800k" },
  { name: "sm", width: 720,  profile: "main", level: "3.1", crf: 27, maxrate: "600k",  bufsize: "1200k" },
];

const ffmpeg = process.env.FFMPEG || "ffmpeg";

async function encode(src, r) {
  const slug = path.basename(src, ".mp4");
  const out = path.join(DIR, `${slug}.${r.name}.mp4`);
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", src,
    // Never upscale: `min(iw,W)` leaves a source narrower than the target
    // alone. -2 keeps the height even, which H.264 requires.
    "-vf", `scale='min(iw,${r.width})':-2:flags=lanczos`,
    "-an",
    "-c:v", "libx264",
    "-profile:v", r.profile, "-level:v", r.level,
    "-pix_fmt", "yuv420p",
    "-preset", "slow",
    "-crf", String(r.crf),
    "-maxrate", r.maxrate, "-bufsize", r.bufsize,
    // A keyframe every two seconds. These loop and are seeked to by the
    // backdrop; a clip whose only keyframe is frame zero has to decode from
    // the start every time.
    "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
    "-movflags", "+faststart",
    out,
  ]);
  return out;
}

const all = await readdir(DIR);
// The sources are the bare slugs; the renditions this script writes are not
// themselves inputs, or a second run would encode the encodes.
const sources = all
  .filter((f) => f.endsWith(".mp4"))
  .filter((f) => !/\.(lg|md|sm)\.mp4$/.test(f))
  .sort();

if (!sources.length) {
  console.error(`no source clips in ${DIR}`);
  process.exit(1);
}

for (const f of sources) {
  const src = path.join(DIR, f);
  const before = (await stat(src)).size;
  const line = [`${f.padEnd(22)} ${(before / 1024).toFixed(0).padStart(5)}kB ->`];
  for (const r of RENDITIONS) {
    const out = await encode(src, r);
    const after = (await stat(out)).size;
    line.push(`${r.name} ${(after / 1024).toFixed(0)}kB`);
  }
  console.log(line.join("  "));
}
