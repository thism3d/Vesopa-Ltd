/**
 * The presentation choices a post can be given.
 *
 * One list, required by both the admin picker and the public template, so the
 * two cannot drift — a layout offered in the editor that the article template
 * does not understand would publish a post that silently renders as something
 * else, which is the exact failure a picker is supposed to prevent.
 *
 * The `key` is what goes in blog_posts.layout. Adding one here and a matching
 * `.bp-<key>` block in brand.css is the whole job; nothing needs a migration,
 * which is why that column is a VARCHAR rather than an ENUM.
 */

const LAYOUTS = [
  {
    key: 'standard',
    name: 'Standard',
    blurb: 'Cover image above the headline, comfortable reading column.',
    hint: 'The safe default. Works with any cover image, and with none.',
  },
  {
    key: 'hero',
    name: 'Hero banner',
    blurb: 'Full-width cover with the headline over it.',
    hint: 'Needs a wide, dark-ish image — light photos swallow white text.',
  },
  {
    key: 'side',
    name: 'Side by side',
    blurb: 'Cover beside the headline and intro on wide screens.',
    hint: 'Good for portrait or square images that a full-width band crops badly.',
  },
  {
    key: 'plain',
    name: 'Text only',
    blurb: 'No cover image on the article page.',
    hint: 'The cover is still used on the listing card and in link previews.',
  },
];

const KEYS = LAYOUTS.map((l) => l.key);
const DEFAULT_LAYOUT = 'standard';

/**
 * An unrecognised value renders as the default rather than as nothing.
 *
 * Matters for rows written before the column existed, and for a layout retired
 * from the list above while posts still reference it.
 */
function resolveLayout(value) {
  return KEYS.includes(value) ? value : DEFAULT_LAYOUT;
}

module.exports = { LAYOUTS, KEYS, DEFAULT_LAYOUT, resolveLayout };
