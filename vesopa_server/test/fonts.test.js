/**
 * Fonts: what a venue's tills are lettered in.
 *
 * Run with `npm test`. No MySQL and no disk beyond a temporary directory: the
 * queries are answered from a script, as in modifiers.test.js and
 * screens.test.js.
 *
 * What actually goes wrong here is not arithmetic. It is a file that looks like
 * a font and is not, a format that works in the browser this page is being
 * looked at in and does nothing at all on the terminal it is being sent to, and
 * one venue's upload landing on another venue's font. Each of those fails
 * silently at a counter, weeks later, in front of customers — so each of them
 * gets a check here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const express = require('express');
const jwt = require('jsonwebtoken');

const {
  fontsRoutes,
  tillFontRoutes,
  slugify,
  fontKind,
  catalogueFor,
  BUILT_INS,
  BUILT_IN_SLUGS,
  WEIGHTS,
  MAX_BYTES,
} = require('../src/fonts');

const SECRET = 'test-secret-not-a-real-one';
const UPLOADS = path.join(__dirname, '..', 'public', 'uploads', 'fonts');

function fakePool(script) {
  const asked = [];
  const answer = (sql, params) => {
    asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of script) {
      if (sql.includes(pattern)) {
        if (rows instanceof Error) throw rows;
        return [rows, []];
      }
    }
    return [[], []];
  };
  return {
    asked,
    query: async (sql, params) => answer(sql, params),
    execute: async (sql, params) => answer(sql, params),
  };
}

function appWith(pool, broadcast = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', fontsRoutes({ pool, broadcast, secret: SECRET }));
  app.use('/api', tillFontRoutes({ pool, broadcast, secret: SECRET }));
  app.use((err, _req, res, _next) => {
    console.error('route error:', err);
    res.status(500).json({ error: String(err) });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

/** A multipart upload, hand-rolled — one file and a couple of fields. */
async function upload(server, path_, { token, file, name, family, weight }) {
  const form = new FormData();
  form.append('font', new Blob([file]), name || 'brand.ttf');
  if (family !== undefined) form.append('family', family);
  if (weight !== undefined) form.append('weight', String(weight));

  const res = await fetch(`http://127.0.0.1:${server.address().port}${path_}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function call(server, method, path_, { body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path_}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/** Four bytes that make a file a font, and four that do not. */
const TTF = Buffer.concat([
  Buffer.from([0x00, 0x01, 0x00, 0x00]),
  Buffer.alloc(64),
]);
const OTF = Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.alloc(64)]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(64)]);
const NOT_A_FONT = Buffer.from('this is a png, honest', 'utf8');

const sessionToken = jwt.sign(
  { sub: 1, email: 'boss@example.com', role: 'office', officeId: 7 },
  SECRET
);
const terminalToken = jwt.sign(
  { scope: 'terminal', office: 'venue@example.com', name: 'Till 2' },
  SECRET
);

const OFFICE = [
  'FROM offices WHERE id',
  [{ contact_email: 'venue@example.com' }],
];

/** Files this run wrote, so it leaves the tree as it found it. */
const written = new Set();
function noteWritten() {
  if (!fs.existsSync(UPLOADS)) return;
  for (const name of fs.readdirSync(UPLOADS)) written.add(name);
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ok  ', name);
    passed++;
  } catch (e) {
    console.error('  FAIL', name);
    throw e;
  }
}

(async () => {
  console.log('\nfonts');

  const before = fs.existsSync(UPLOADS) ? new Set(fs.readdirSync(UPLOADS)) : new Set();

  // -- what a font is -------------------------------------------------------

  await test('the four signatures a till can actually read are accepted', () => {
    assert.strictEqual(fontKind(TTF), 'ttf');
    assert.strictEqual(fontKind(OTF), 'otf');
    assert.strictEqual(
      fontKind(Buffer.concat([Buffer.from('true', 'latin1'), Buffer.alloc(8)])),
      'ttf'
    );
    assert.strictEqual(
      fontKind(Buffer.concat([Buffer.from('ttcf', 'latin1'), Buffer.alloc(8)])),
      'ttf'
    );
  });

  await test('a woff is told apart from rubbish, because they are refused differently', () => {
    // Both are refused, and the *reason* is the whole point: "that is not a
    // font" is unhelpful and wrong for a file that plainly is one, and a
    // manager told that will go and find the same woff2 again.
    assert.strictEqual(fontKind(WOFF2), 'woff');
    assert.strictEqual(fontKind(NOT_A_FONT), null);
    assert.strictEqual(fontKind(Buffer.alloc(2)), null);
    assert.strictEqual(fontKind(null), null);
  });

  await test('a family name becomes a slug a button can hold', () => {
    assert.strictEqual(slugify('Brand Sans Pro'), 'brand-sans-pro');
    assert.strictEqual(slugify('  Ω Display  '), 'display');
    assert.strictEqual(slugify('!!!'), '');
    assert.strictEqual(slugify(null), '');
  });

  // -- the catalogue --------------------------------------------------------

  await test('the built-in families are read from the tree, and there are some', () => {
    // If this is ever zero the editor still works and every till letters
    // plainly — which is the designed failure — but it is not one anybody
    // wants to discover from a venue.
    assert.ok(BUILT_INS.length >= 10, `only ${BUILT_INS.length} built-in fonts`);
    for (const font of BUILT_INS) {
      assert.ok(font.slug, 'a built-in with no slug');
      assert.ok(font.faces.length, `${font.slug} has no faces`);
      for (const face of font.faces) {
        assert.ok(WEIGHTS.includes(face.weight), `${font.slug}: ${face.weight}`);
        // Served from this back office, not from a CDN. The whole offline
        // design rests on this being a path and not a URL.
        assert.ok(
          face.url.startsWith('/assets/fonts/'),
          `${font.slug} is served from ${face.url}`
        );
        assert.ok(
          fs.existsSync(path.join(__dirname, '..', 'public', face.url)),
          `${face.url} is listed but not in the tree`
        );
      }
    }
  });

  await test('a venue’s own fonts are listed after the built-ins', async () => {
    const pool = fakePool([
      [
        'FROM epos_fonts',
        [
          { slug: 'brand-sans', family: 'Brand Sans', weight: 400, file_name: 'a.ttf', byte_size: 1 },
          { slug: 'brand-sans', family: 'Brand Sans', weight: 700, file_name: 'b.ttf', byte_size: 1 },
        ],
      ],
    ]);
    const list = await catalogueFor(pool, 'venue@example.com');
    const own = list.filter((f) => !f.builtIn);
    assert.strictEqual(own.length, 1, 'the two weights are one family');
    assert.deepStrictEqual(own[0].faces.map((f) => f.weight), [400, 700]);
    assert.ok(list.indexOf(own[0]) > 0, 'the venue’s font came before a built-in');
    assert.ok(own[0].faces[0].url.startsWith('/uploads/fonts/'));
  });

  await test('a venue that shadows a built-in gets its own', async () => {
    // They put it there. An upload that appears to do nothing is a worse
    // outcome than one that wins.
    const pool = fakePool([
      [
        'FROM epos_fonts',
        [{ slug: 'inter', family: 'Inter', weight: 400, file_name: 'x.ttf', byte_size: 1 }],
      ],
    ]);
    const list = await catalogueFor(pool, 'venue@example.com');
    const inter = list.filter((f) => f.slug === 'inter');
    assert.strictEqual(inter.length, 1, 'two fonts answer to the same slug');
    assert.strictEqual(inter[0].builtIn, false);
  });

  // -- uploading ------------------------------------------------------------

  await test('a .woff2 is refused, and the reason says what to send instead', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await upload(server, '/api/fonts', {
      token: sessionToken,
      file: WOFF2,
      name: 'brand.woff2',
      family: 'Brand Sans',
      weight: 400,
    });
    server.close();
    assert.strictEqual(res.status, 400);
    // The specific words matter more than usual here: this is the one error a
    // manager cannot work out for themselves, because the file works in the
    // browser they are looking at it in.
    assert.match(res.body.error, /woff/i);
    assert.match(res.body.error, /\.ttf|\.otf/i);
  });

  await test('a file that is not a font is refused whatever it is called', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await upload(server, '/api/fonts', {
      token: sessionToken,
      file: NOT_A_FONT,
      name: 'definitely-a-font.ttf',
      family: 'Brand Sans',
      weight: 400,
    });
    server.close();
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a TrueType or OpenType font/i);
  });

  await test('a name that collides with a built-in is refused, not merged', async () => {
    // Two fonts answering to `inter` on one till is a font nobody can predict.
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await upload(server, '/api/fonts', {
      token: sessionToken,
      file: TTF,
      family: 'Inter',
      weight: 400,
    });
    server.close();
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /built-in/i);
  });

  await test('a font with no name is refused rather than stored as ""', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await upload(server, '/api/fonts', {
      token: sessionToken,
      file: TTF,
      family: '   ',
      weight: 400,
    });
    server.close();
    assert.strictEqual(res.status, 400);
  });

  await test('a good upload is stored, named for what it is, and pushed', async () => {
    const sent = [];
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool, (msg) => sent.push(msg.type)));
    const res = await upload(server, '/api/fonts', {
      token: sessionToken,
      file: OTF,
      name: 'BrandSans-Bd_v2_FINAL.otf',
      family: 'Brand Sans',
      weight: 700,
    });
    server.close();
    noteWritten();

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(
      { slug: res.body.slug, family: res.body.family, weight: res.body.weight },
      { slug: 'brand-sans', family: 'Brand Sans', weight: 700 }
    );

    const insert = pool.asked.find((q) => q.sql.includes('INSERT INTO epos_fonts'));
    assert.ok(insert, 'nothing was written');
    // The extension follows the bytes, not the filename. An .otf renamed .ttf
    // is impossible to diagnose from a directory listing.
    const stored = insert.params[4];
    assert.ok(stored.startsWith('brand-sans-700-'), `stored as ${stored}`);
    assert.ok(stored.endsWith('.otf'), `stored as ${stored}`);
    assert.ok(
      fs.existsSync(path.join(UPLOADS, stored)),
      'the row was written but the file was not'
    );

    // Tills cache the list. Without the push, the font is in the back office
    // and on none of the terminals until somebody restarts one.
    assert.ok(sent.includes('screens'), 'the tills were never told');
  });

  await test('two venues uploading the same name do not share a file', async () => {
    const pool = fakePool([OFFICE]);
    const server = await listen(appWith(pool));
    for (let i = 0; i < 2; i++) {
      await upload(server, '/api/fonts', {
        token: sessionToken,
        file: TTF,
        family: 'House Sans',
        weight: 400,
      });
    }
    server.close();
    noteWritten();

    const names = pool.asked
      .filter((q) => q.sql.includes('INSERT INTO epos_fonts'))
      .map((q) => q.params[4]);
    assert.strictEqual(names.length, 2);
    assert.notStrictEqual(
      names[0],
      names[1],
      'the second upload would have overwritten the first venue’s file'
    );
  });

  await test('a font is not something an anonymous request can upload', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await upload(server, '/api/fonts', {
      file: TTF,
      family: 'Brand Sans',
      weight: 400,
    });
    server.close();
    assert.strictEqual(res.status, 401);
  });

  await test('a till uploads on its terminal token and on nothing less', async () => {
    const bare = await listen(appWith(fakePool([])));
    const refused = await upload(bare, '/api/till/fonts', {
      file: TTF,
      family: 'Brand Sans',
      weight: 400,
    });
    bare.close();
    // Every other /till/ route is an unauthenticated read scoped by an office.
    // This one writes a file to our disk, and that is not the same trade.
    assert.strictEqual(refused.status, 401);

    const pool = fakePool([]);
    const server = await listen(appWith(pool));
    const ok = await upload(server, '/api/till/fonts', {
      token: terminalToken,
      file: TTF,
      family: 'Counter Sans',
      weight: 400,
    });
    server.close();
    noteWritten();
    assert.strictEqual(ok.status, 201);

    const insert = pool.asked.find((q) => q.sql.includes('INSERT INTO epos_fonts'));
    // Scoped to the token's office, never to anything in the request body.
    assert.strictEqual(insert.params[0], 'venue@example.com');
    assert.strictEqual(insert.params[6], 'Till 2', 'who uploaded it was not kept');
  });

  // -- removing -------------------------------------------------------------

  await test('a built-in cannot be removed', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await call(server, 'DELETE', '/api/fonts/inter', {
      token: sessionToken,
    });
    server.close();
    assert.strictEqual(res.status, 400);
    assert.ok(BUILT_IN_SLUGS.has('inter'));
  });

  await test('removing a font a venue does not have is a 404, not a 500', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await call(server, 'DELETE', '/api/fonts/nothing-here', {
      token: sessionToken,
    });
    server.close();
    assert.strictEqual(res.status, 404);
  });

  // -- the till's half ------------------------------------------------------

  await test('a till reads the list without a session, scoped by its office', async () => {
    const pool = fakePool([]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'GET', '/api/till/fonts?office=venue@example.com');
    server.close();
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.fonts));
    assert.ok(res.body.fonts.length >= 10);
    const read = pool.asked.find((q) => q.sql.includes('FROM epos_fonts'));
    assert.strictEqual(read.params[0], 'venue@example.com');
  });

  await test('a till read with no office is refused rather than answered for everyone', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'GET', '/api/till/fonts');
    server.close();
    assert.strictEqual(res.status, 400);
  });

  await test('the venue font set from a till is sanitised and pushed', async () => {
    const sent = [];
    const pool = fakePool([]);
    const server = await listen(appWith(pool, (msg) => sent.push(msg.type)));
    const res = await call(server, 'PUT', '/api/till/font', {
      token: terminalToken,
      body: { fontFamily: '  Brand/Sans;DROP  ' },
    });
    server.close();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.fontFamily, 'brandsansdrop');
    const write = pool.asked.find((q) => q.sql.includes('epos_till_settings'));
    assert.strictEqual(write.params[0], 'venue@example.com');
    assert.strictEqual(write.params[1], 'brandsansdrop');
    // 'till-settings', not 'screens': the list has not changed, only the choice.
    assert.ok(sent.includes('till-settings'), 'the tills were never told');
  });

  await test('clearing the venue font stores null, not an empty string', async () => {
    // A column holding '' would be a font slug that matches nothing, and the
    // till would letter plainly while the row insisted a font was set.
    const pool = fakePool([]);
    const server = await listen(appWith(pool));
    const res = await call(server, 'PUT', '/api/till/font', {
      token: terminalToken,
      body: { fontFamily: '' },
    });
    server.close();
    assert.strictEqual(res.body.fontFamily, null);
    const write = pool.asked.find((q) => q.sql.includes('epos_till_settings'));
    assert.strictEqual(write.params[1], null);
  });

  await test('the venue font cannot be set without a terminal token', async () => {
    const server = await listen(appWith(fakePool([])));
    const res = await call(server, 'PUT', '/api/till/font', {
      body: { fontFamily: 'inter' },
    });
    server.close();
    assert.strictEqual(res.status, 401);
  });

  // -- the ceiling ----------------------------------------------------------

  await test('a font larger than the cap is refused before it is written', async () => {
    const server = await listen(appWith(fakePool([OFFICE])));
    const res = await upload(server, '/api/fonts', {
      token: sessionToken,
      file: Buffer.concat([TTF, Buffer.alloc(MAX_BYTES + 1024)]),
      family: 'Enormous Sans',
      weight: 400,
    });
    server.close();
    noteWritten();
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /larger than/i);
    // Nothing on disk. multer's memory storage is what makes that true: disk
    // storage would have written the file before anything looked at it, into a
    // directory that is served statically.
    const now = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : [];
    assert.ok(
      !now.some((n) => n.startsWith('enormous-sans-')),
      'a refused upload was written anyway'
    );
  });

  // Leave the tree as it was found. These are real files in public/uploads.
  noteWritten();
  for (const name of written) {
    if (before.has(name)) continue;
    try {
      fs.unlinkSync(path.join(UPLOADS, name));
    } catch {
      /* already gone */
    }
  }

  console.log(`\nfonts: ${passed}/${passed} passed\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
