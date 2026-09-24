# The web terminal

A shell on the customer's own hosting account, in the browser, on
`cloud.vesopa.com`. Nothing here sends anyone to HestiaCP's panel.

## The shape of it

    browser ──wss──> nginx ──> the website (vesopasoftware) ──unix socket──> broker (root) ──> pty ──> shell (the customer)

Three pieces, and the split between them is the security design:

| | runs as | decides |
| --- | --- | --- |
| `public/assets/js/terminal.js` | the browser | nothing. It draws and types. |
| `src/terminal.js` | the website's user | **who** is asking — session cookie, account active, hosting active |
| `terminal/broker.py` | root | **whether that is allowed** — never root, never a non-Hestia account, never a `nologin` package |

Neither half trusts the other. The browser never names the account it wants —
that is read from the session — and the broker re-checks everything it is told
anyway, so a compromised website still cannot open a shell as an arbitrary user.

The broker is the only privileged part, and it is deliberately tiny: one file,
standard library only, no network socket. The alternatives were running the
website as root (every route bug becomes a root bug) or giving it a blanket
sudo rule (the same thing wearing a hat).

## Installing it on a node

```bash
mkdir -p /opt/vesopa-terminal
install -m 0755 terminal/broker.py            /opt/vesopa-terminal/broker.py
install -m 0644 terminal/vesopa-terminal.service /etc/systemd/system/

# The website's group. Only members can reach the socket.
sed -i "s/^Environment=VESOPA_TERMINAL_GROUP=.*/Environment=VESOPA_TERMINAL_GROUP=<web user's group>/" \
  /etc/systemd/system/vesopa-terminal.service

systemctl daemon-reload
systemctl enable --now vesopa-terminal
```

Check it came up:

```bash
systemctl is-active vesopa-terminal
ls -l /run/vesopa-terminal/broker.sock   # want srw-rw---- root <group>
```

`0660 root:<group>` **is** the access control. There is no token on this
interface on purpose — a shared secret would live in the website's `.env`, and
anything that can read that can already read everything else it has. The kernel
enforces socket permissions; it cannot leak into a log or a backup. If the
socket is ever `0666`, any account on the box (customers have shells now) can
ask for a shell as any other customer.

## nginx

Websockets need the upgrade headers proxied. Hestia's per-domain `nodeapp.conf`
already sets them, and there is a `$connection_upgrade` map in
`/etc/nginx/conf.d/`.

**One thing had to be removed from `NodeJS.tpl` and `NodeJS.stpl`:**

```nginx
proxy_hide_header Upgrade;      # deleted
```

It hides `Upgrade` from the **response**, not the request. nginx completed the
handshake and returned `101 Switching Protocols` without the header the protocol
requires, and every browser rejected it — the error is
`Unexpected server response: 101`, which reads like a server fault and is a
header being stripped on the way out. Rebuild the domains after changing the
template (`v-rebuild-web-domains <user> no`).

## Shell access is a package setting

Hestia hides the terminal for any account whose shell is `nologin`, and the
broker refuses one. Every plan package grants `bash` — see
`scripts/create-hestia-packages.sh`. An account on a `nologin` package gets a
clear refusal rather than a hang.

## Limits

| | where | why |
| --- | --- | --- |
| 3 shells per customer | `TERMINAL_MAX_SESSIONS` | each is a real process on a shared box |
| 15 min idle | `VESOPA_TERMINAL_IDLE` | a closed tab leaves a shell running |
| 4 h hard cap | `VESOPA_TERMINAL_MAX` | because `top` counts as activity |

## On a phone

The two things web terminals usually get wrong, both handled in
`public/assets/js/terminal.js`:

- **Keys that are not on the keyboard.** No Esc, Tab, Ctrl or arrows on a phone,
  and that is most of what a shell needs. There is a scrollable key bar, and
  Ctrl is a *sticky* modifier — you cannot hold two soft keys at once, so it
  arms the next keystroke instead.
- **The keyboard covering the prompt.** On mobile the keyboard overlays the
  viewport without resizing it, so `window.innerHeight` still reports the full
  screen. The layout follows `visualViewport` instead, and the key bar is
  `position: sticky` so it rides above the keyboard.

## xterm.js is vendored, not from a CDN

`public/assets/vendor/xterm/` holds the built files, copied from the
devDependencies. The site's CSP is `script-src 'self'` and it loads nothing from
a third-party origin — that is a property worth keeping. To update:

```bash
npm install --save-dev @xterm/xterm@latest @xterm/addon-fit@latest
cp node_modules/@xterm/xterm/lib/xterm.js       public/assets/vendor/xterm/
cp node_modules/@xterm/xterm/css/xterm.css      public/assets/vendor/xterm/
cp node_modules/@xterm/addon-fit/lib/addon-fit.js public/assets/vendor/xterm/
```

## Verified

On 34.63.118.67, 2026-08-30, over the public internet:

- a signed-in customer gets a shell as their own unix user, correct `uid`, in
  their own home
- **no cookie** → closed 4001; **forged cookie** → closed 4001 (the session
  signature is checked, and so is the password fingerprint, so a cookie minted
  before a password change stops working)
- **cross-origin** and **no `Origin` header** → 403 at the handshake. A
  websocket is not covered by the same-origin policy the way `fetch` is: any
  page anywhere can open one and the browser attaches the customer's cookies.
  Without that check a link a customer clicks could open a shell on their
  account and stream it to somebody else.
- the broker refuses `root`, unknown accounts, non-Hestia system accounts
  (`hestiaweb`), and `../root`
