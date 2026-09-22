/**
 * Every template must compile.
 *
 * WHY THIS TEST EXISTS, in one incident.
 *
 * `link-required.ejs` is shown on one rare path: somebody signs in with Google
 * using an address that already belongs to a Vesopa account. Inside it, an
 * explanatory comment had been written as
 *
 *     <%
 *       /* … the person's <%= provider %> account … *\/
 *     %>
 *
 * EJS tags do not nest, so the inner `<%=` ended the outer tag and the file
 * would not compile. Nothing caught it: the smoke tests never take that path,
 * every other page rendered perfectly, and the deploy reported success. The
 * first thing that touched it was a real person signing in with a real Google
 * account, who got "Something went wrong".
 *
 * Compiling is not rendering — this cannot prove a page looks right — but it
 * proves every one of them can be produced at all, which is the failure that
 * actually happened and the one that hides until the worst moment.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');

function everyTemplate(directory = VIEWS, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) everyTemplate(full, found);
    else if (entry.name.endsWith('.ejs')) found.push(full);
  }
  return found;
}

const templates = everyTemplate();

test('there are templates to check', () => {
  assert.ok(templates.length > 10, `only found ${templates.length}`);
});

for (const file of templates) {
  const name = path.relative(VIEWS, file).replace(/\\/g, '/');

  test(`${name} compiles`, () => {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(
      () => ejs.compile(source, { filename: file }),
      `${name} does not compile`,
    );
  });

  test(`${name} has no EJS tag nested inside another`, () => {
    /*
     * A second, blunter check that catches the same mistake before the compiler
     * has to, and with a message that says what is wrong rather than "could not
     * find matching close tag" — which does not tell you where or why.
     *
     * It walks the file finding each `<%` and its matching `%>`, and complains
     * if another `<%` appears in between. That is exactly the shape of writing
     * `<%= something %>` inside a `<% /* comment *\/ %>` block, which is a
     * natural thing to do and is always wrong.
     */
    const source = fs.readFileSync(file, 'utf8');
    let index = 0;

    while (index < source.length) {
      const open = source.indexOf('<%', index);
      if (open === -1) break;

      // `<%%` is the escape for a literal `<%` and opens nothing.
      if (source[open + 2] === '%') {
        index = open + 3;
        continue;
      }

      const close = source.indexOf('%>', open + 2);
      assert.notStrictEqual(close, -1, `${name}: an EJS tag at offset ${open} is never closed`);

      const inner = source.slice(open + 2, close);
      const nested = inner.indexOf('<%');
      assert.strictEqual(
        nested,
        -1,
        `${name}: an EJS tag is opened inside another at offset ${open + 2 + nested}. ` +
          'EJS tags do not nest — this most often happens by writing <%= x %> ' +
          'inside a <% /* comment */ %> block, and stops the whole file compiling.',
      );

      index = close + 2;
    }
  });
}
