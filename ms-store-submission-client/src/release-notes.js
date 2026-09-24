// The shape a Vesopa release note has to be in, and the reason it has one.
//
// From 1.6.7.0 onwards the venue asked for every note on every app to read:
//
//     Version 1.6.8.0 - Short title
//     <blank line>
//     One paragraph per line, blank line between paragraphs.
//
// ONE PARAGRAPH PER LINE, NOT WRAPPED — which is the half that keeps being got
// wrong, because it is the opposite of how prose looks in an editor. Partner
// Center renders every newline in this field as a real line break, so text
// wrapped at 78 characters arrives on the public Store page broken at 78
// characters, mid-sentence, on every line. The venue found that on the 1.6.7.0
// submissions and asked for it to be fixed.
//
// Lived in examples/set-notes.js until 1.6.8.0, where the staging script did
// not check it at all — so notes uploaded with a package went unvalidated and
// only notes edited afterwards were looked at, which is exactly the wrong way
// round. One reader, used by both.
import fs from "node:fs";

/**
 * Read a notes file and refuse it if it is not in the venue's shape.
 *
 * Throws with a message meant for whoever is running the release, not a stack
 * trace: the caller prints it and stops.
 */
export function readReleaseNotes(file) {
  const notes = fs.readFileSync(file, "utf8").trim();
  if (!notes) throw new Error(`${file} is empty.`);

  if (notes.length > 1500) {
    throw new Error(
      `${file} is ${notes.length} characters; the Store's limit is 1500.`
    );
  }

  const lines = notes.split("\n");
  if (!/^Version \d+\.\d+\.\d+\.\d+ - \S/.test(lines[0])) {
    throw new Error(
      `The first line must read "Version x.x.x.x - Short title". Got: ` +
        `${lines[0]}`
    );
  }
  if (lines[1] !== "") {
    throw new Error("The title line must be followed by a blank line.");
  }

  // The wrap check. A paragraph typed as one line is long; prose wrapped by an
  // editor is a run of lines that all stop around the same column and none of
  // which ends a sentence. One such line is a short paragraph and fine; several
  // is a wrapped block.
  const body = lines.slice(2).filter((l) => l.trim() !== "");
  if (body.length === 0) {
    throw new Error("There is a title and nothing else.");
  }
  const suspicious = body.filter(
    (l) => l.length > 55 && l.length < 100 && !/[.!?:]$/.test(l.trim())
  );
  if (suspicious.length > 1) {
    throw new Error(
      `${suspicious.length} lines look hard-wrapped — Partner Center will ` +
        `break the text exactly where they end. Write one paragraph per ` +
        `line.\n` +
        suspicious
          .slice(0, 3)
          .map((l) => `  "${l}"`)
          .join("\n")
    );
  }

  return notes;
}

/**
 * The version the notes say they are for.
 *
 * Checked against the package's own version by the staging script, because the
 * two are set in different files and shipping 1.6.7.0's words over 1.6.8.0's
 * binary is a mistake nothing else would catch.
 */
export function versionInNotes(notes) {
  return /^Version (\d+\.\d+\.\d+\.\d+)/.exec(notes)?.[1] ?? null;
}
