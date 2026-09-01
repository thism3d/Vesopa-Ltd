/* What this machine can actually be asked to do.
 *
 * One module because the page has several subsystems that each need the same
 * answer — the particle field, the video backdrop, the star canvas, the
 * ambient pass — and when each worked it out for itself they disagreed. The
 * field would decide it was on a phone and thin out while the backdrop kept
 * three 1280px decoders alive behind it.
 *
 * Two things worth knowing about the signals here:
 *
 *   `navigator.deviceMemory` does not exist in Safari, which is precisely the
 *   browser where the answer matters most. Anything that leans on it is
 *   really only measuring Chrome. So the defaults below key off the pointer
 *   type and the viewport — facts every browser reports honestly — and the
 *   memory and core counts are used only to move a device *down* a tier, never
 *   up.
 *
 *   None of it is a substitute for measurement. `reportFps` is how the running
 *   page tells this module it was wrong, and everything that consumes `strain`
 *   is expected to shed work when it goes up.
 */

const mm = (q) => matchMedia(q).matches;

export const coarse = mm("(pointer: coarse)");
export const reduced = mm("(prefers-reduced-motion: reduce)");

/** iPhone or iPad. iPadOS reports itself as a Mac, so the touchscreen is the tell. */
export function isIOS() {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

const conn = navigator.connection || {};
export const saveData = !!conn.saveData;
/** 2g, slow-2g, or anything the browser is willing to call slow. */
export const slowLink = /(^|-)2g$/.test(conn.effectiveType || "");

const cores = navigator.hardwareConcurrency || 0;
const mem = navigator.deviceMemory || 0;          // absent in Safari

/** A phone, or a small tablet held like one. */
export const phone = coarse && Math.min(innerWidth, innerHeight) < 820;

/**
 * A phone, and specifically not a tablet.
 *
 * `phone` above draws its line at 820px because that is where the particle
 * field has to thin out, and on that measure every iPad but the largest is a
 * phone — an iPad in portrait is 768 to 834 points wide. That is the right
 * call for the field and the wrong one for video: it handed a 10-inch tablet
 * with a 2x display one 720px decoder and the phone encode, which is the
 * "why does the backdrop look soft and arrive late on my iPad" report.
 *
 * So video sizes itself off this instead. 600 is below any tablet in
 * circulation and above every phone in landscape.
 */
export const handset = coarse && Math.min(innerWidth, innerHeight) < 600;

/** Coarse pointer, big screen. An iPad, or an Android tablet. */
export const tablet = coarse && !handset;

/**
 * Weak enough that the page should not spend everything it has.
 *
 * Deliberately generous about what counts. The cost of treating a capable
 * phone as a modest one is a slightly sparser field; the cost of the reverse
 * is a page that judders under the thumb, which is the complaint this is here
 * to answer.
 */
export const lowEnd =
  saveData || slowLink ||
  (cores > 0 && cores <= 4) ||
  (mem > 0 && mem <= 4) ||
  // An iPhone small enough to be a 7 Plus or older is an A10 at best. Nothing
  // in any web API distinguishes it, and it is the machine the site was
  // reported broken on, so screen size stands in for the chip.
  (isIOS() && Math.max(screen.width, screen.height) <= 736);

/**
 * How many <video> elements may be alive at once.
 *
 * Browsers cap concurrent hardware decoders and older iOS simply refuses to
 * start the next one — which presents as "some of the videos never play", on
 * exactly the devices that are hardest to debug on. One is always enough to
 * show the section you are looking at; the rest is prefetching, which the
 * cache does better and without a decoder.
 */
export const videoBudget = lowEnd ? 1 : handset ? 1 : tablet ? 2 : 3;

/** Which encode to fetch. See tools/encode-video.mjs for what these are. */
export const videoRendition =
  saveData || slowLink || lowEnd || handset ? "sm"
  : tablet ? "md"
  : "lg";

/** Cap the canvas backing store. Retina on a weak GPU is four times the fill. */
export const dprCap = lowEnd ? 1.25 : phone ? 1.75 : 2;

/* ---------- measured strain ---------- */

let strainLevel = 0;
const listeners = new Set();

/** 0 = comfortable, 1 = shedding work, 2 = shed everything optional. */
export const strain = () => strainLevel;

/** Called when strain rises. Never called on the way back down: a page that
 *  restores effects the moment it can afford them oscillates visibly. */
export function onStrain(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * The running page's own verdict, from the frame loop.
 *
 * Ratcheted, never lowered: a device that could not hold the frame once will
 * be asked again the moment the load lightens, and effects flickering out and
 * back is worse than simply staying at the lower setting.
 *
 * But because it never comes back down, it must not be jumpy. A single slow
 * sample is not evidence — the opening second of this page decodes a video,
 * builds ten morph targets and lays out the whole document, and a machine that
 * dips there is not a machine that should lose its backdrop for the rest of
 * the visit. So each level needs several consecutive samples below its
 * threshold before it takes, and one good sample resets the count.
 *
 * Level 2 is deliberately far down: it is the level that stops video
 * altogether, and that is a large, obvious loss to inflict on a guess.
 */
const NEEDED = 3;              // consecutive samples, at ~2 per second
let lowRun = 0, lastWant = 0;

export function reportFps(fps) {
  const want = fps < 26 ? 2 : fps < 48 ? 1 : 0;
  if (want === 0) { lowRun = 0; lastWant = 0; return; }
  lowRun = want === lastWant ? lowRun + 1 : 1;
  lastWant = want;
  if (lowRun < NEEDED) return;
  if (want <= strainLevel) return;
  strainLevel = want;
  for (const fn of listeners) { try { fn(strainLevel); } catch { /* never break the loop */ } }
}
