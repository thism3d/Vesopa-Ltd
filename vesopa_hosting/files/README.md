# The file manager

A file manager for a customer's hosting account, served by this site at
`/panel/files`. Nothing sends a customer to HestiaCP's own file manager on
`panel.vesopa.com:2083` any more — that meant a second sign-in with a password
out of a welcome email, and a control panel that looks nothing like this one.

Same shape as the web terminal (`terminal/`), and worth reading that one's
README alongside this: the two share a security model and half the reasoning.

## Three pieces, and the split is the security design

    browser ──https──> nginx ──> website (vesopasoftware) ──unix socket──> broker (root) ──> the customer's files

| | what it decides |
| --- | --- |
| `public/assets/js/files.js` | draws, types, uploads. Decides nothing. |
| `src/files.js` + `src/routes/panel-files.js` | **who** is asking — session cookie, active customer, account with live hosting. The browser never names an account. |
| `files/broker.py` | **whether that is allowed** — never root, never an account Hestia does not have, never outside that account's home. Then it drops to that user and lets the kernel enforce the rest. |

**The privilege drop is the real boundary.** Every path check in the broker is
worth having, but the guarantee that one customer cannot read another's files
comes from `setuid()` plus ordinary unix permissions, not from string comparison
on pathnames. The path checks stop accidents; the uid stops attacks.

**The unix socket's `0660 root:<web group>` IS the access control.** No token,
deliberately — a shared secret would live in the website's `.env`, and anything
that can read that file can already read everything else it has. If it is ever
`0666`, any account on the box (customers have shells) can ask for any other
customer's files.

Python, because `pty` and `zipfile` are stdlib and a native module would be a
build dependency on a production host.

## Install

    install -d -m 0755 /opt/vesopa-files
    install -m 0755 files/broker.py /opt/vesopa-files/broker.py
    install -m 0644 files/vesopa-files.service /etc/systemd/system/vesopa-files.service
    systemctl daemon-reload
    systemctl enable --now vesopa-files
    systemctl status vesopa-files --no-pager

Then check the socket is group-owned by the account the website runs as, and is
not world-accessible:

    ls -l /run/vesopa-files/broker.sock     # srw-rw---- root vesopasoftware

`VESOPA_FILES_GROUP` in the unit must match that group, and `FILES_SOCKET` in
the app's `.env` must match `VESOPA_FILES_SOCKET`.

## What it refuses, and why each one is there

| refusal | why |
| --- | --- |
| `root`, uid 0 | Hestia's admin account is a real login; this must not be a route to it. |
| an account with no `user.conf` | `info` and `ubuntu` are unix users on this box and neither is a customer. Hestia's record is what decides who is a hosting account. |
| a suspended account | suspension has to mean something. |
| `..` in a path | dropped, not resolved — so `a/../../b` cannot walk above the root by arithmetic. |
| a symlink whose target leaves the home | only when the file's **contents** are being read or written. Deleting or renaming a link acts on the link, which is what `rm` does and what people expect. |
| an archive entry named `../../.ssh/authorized_keys` | Zip Slip. On a box where accounts have shells, that specific example is a login. Both zip and tar are checked, and tar's links and devices are skipped outright. |
| setuid/setgid/sticky in a chmod | nobody sets those from a web UI on purpose. |
| a recursive chmod putting +x on files | a recursive `755` over a web root is the usual reason every `.php` in a site becomes executable. Directories get the mode; files get it without the execute bits. |

Unlike the terminal, this does **not** require the account's Hestia package to
grant a shell. Files are a different capability: a customer on a `nologin`
package still owns their website and still has to be able to edit it.

## Things worth not rediscovering

- **Two routes do not take a JSON body, deliberately.** `server.js` parses JSON
  at a 512 KB limit, which is right for the rest of the app; the editor saves up
  to 2 MB. `write` takes `text/plain` and slips past that parser entirely.
  `upload` takes raw bytes and streams them to the broker, so a 400 MB file
  never sits in the website's heap.
- **A zip download has no `Content-Length`.** It is generated as it is sent —
  `zipfile` on an unseekable stream emits data descriptors — so the size is not
  known when the headers go out. Chunked encoding handles it; the only cost is
  no progress bar. Staging it to a temp file first would need free space inside
  a quota the customer may already be near.
- **Nothing is ever served as its own content type.** `cloud.vesopa.com` holds
  the session cookie for every customer, so a customer's own `x.html` served as
  `text/html` from this origin would be a stored XSS with a file upload as the
  delivery mechanism. Everything downloads as `application/octet-stream`;
  images may render inline for the preview and get `nosniff` plus a sandbox CSP.
- **Uploads are one request per file.** A multipart batch gives you one progress
  bar for twelve files and loses all twelve when one fails.
- **The broker forks per connection.** Without that, one 400 MB upload holds the
  whole service and every other customer waits behind it.
- **The editor is a real `<textarea>` with transparent text over a highlighted
  `<pre>`.** A canvas-drawn editor loses the caret, the selection handles and the
  on-screen keyboard's arrow keys — everything a phone depends on. Every metric
  in `.fm-hl` and `.fm-code textarea` has to stay identical or the highlight
  slides out of register with the characters.

## Verifying it

From the box, as the website's user, the broker should answer and refuse:

    sudo -u vesopasoftware python3 - <<'PY'
    import json, socket, struct
    def ask(payload):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect('/run/vesopa-files/broker.sock')
        raw = json.dumps(dict(payload, body=0)).encode()
        s.sendall(struct.pack('!I', len(raw)) + raw)
        n = struct.unpack('!I', s.recv(4))[0]
        return json.loads(s.recv(n))
    print(ask({'user': 'root', 'op': 'list', 'path': ''}))          # refused
    print(ask({'user': 'nosuchuser', 'op': 'list', 'path': ''}))    # refused
    print(ask({'user': 'info', 'op': 'list', 'path': ''}))          # refused: not a Hestia account
    PY

In the browser, signed in as a customer: the escape attempts must all fail.
`/panel/files/api/list?path=../../etc` lists the home directory, not `/etc`.
