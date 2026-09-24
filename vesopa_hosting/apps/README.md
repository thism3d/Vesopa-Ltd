# The applications broker

The privileged half of the panel's app installer, runtime picker and Node
process manager. Third of three brokers, and it follows the same split as
`terminal/` and `files/`:

    src/apps.js      WHO is asking — session, customer, account. Runs as the
                     website's own user and can do none of the work itself.
    apps/broker.py   WHETHER THAT IS ALLOWED — then setuid() to the customer
                     and let the kernel do the rest.

## What it does

| Operation | What it is for |
|---|---|
| `runtimes` | Which PHP versions and Node lines the node has, and what each PHP build has compiled in |
| `nodeapps` | pm2 process list **plus a port probe**, which is what makes "Working" mean working |
| `nodeaction` | start / stop / restart / reload / delete, then `pm2 save` |
| `nodelogs` | The tail of `out-0.log` and `error-0.log` |
| `readenv` / `writeenv` | The app's `.env` |
| `phpconfig` / `setphpconfig` | Five PHP settings, written to `.user.ini` in the docroot |
| `plugins` / `plugin` | npm packages for a Node app, plugins for a WordPress site |
| `install` / `job` / `jobs` | Start an install, and follow it |

## The four properties worth knowing

**Nothing is ever deleted.** Every install builds under `~/.vesopa/build/<id>`
and is moved into place only on success. Whatever was in the web root goes to
`~/.vesopa/replaced/<name>-<timestamp>` and stays there. A customer who installs
over their own site has made a mistake that one `mv` undoes.

**No command ever crosses the socket.** The web tier sends an operation name and
validated arguments. Recipes live in `RECIPES` here. `shell=True` appears
nowhere in the file and should not start to.

**One root phase, named and small.** `root_phase_install` runs
`v-add-nodejs-app` before the fork and before the drop, because writing nginx
config and enabling a systemd unit is not the customer's to do. A PHP install
has no root phase at all.

**pm2 "online" is not "working".** `health()` in `src/apps.js` combines the pm2
status, the restart count read against uptime, and an HTTP probe of the app's
port. A crash-looping app reports as crash-looping; an app that is up but not
listening reports as "running, not answering". A panel that printed pm2's word
next to a green dot would be telling customers their broken site is fine.

## Installing it on a node

    install -d -m 0755 /opt/vesopa-apps
    install -m 0755 apps/broker.py /opt/vesopa-apps/broker.py
    install -m 0644 apps/vesopa-apps.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now vesopa-apps

Then check it:

    systemctl status vesopa-apps
    ls -l /run/vesopa-apps/broker.sock     # srw-rw---- root vesopasoftware

The web tier finds it at `APPS_SOCKET` (default `/run/vesopa-apps/broker.sock`).
With no socket there, `src/apps.js` falls back to mock data and every page still
renders — so a dead broker shows as invented figures rather than a stack trace.
Set `APPS_MODE=live` in the app's `.env` on the server to make that a hard
failure instead, which is what you want in production.

## What it needs on the node

- `python3` (3.9+), `tar`, `unzip`, `git`, `curl`
- pm2 at `/opt/pm2/bin/pm2` (or on PATH), one daemon per user
- Node lines under `/opt/nodejs/<major>/bin/`
- `v-add-nodejs-app` in `/usr/local/hestia/bin`
- PHP-FPM templates in `/usr/local/hestia/data/templates/web/php-fpm`

`wp-cli` and `composer` are fetched on first use into the customer's own
`~/.vesopa/`, rather than installed system-wide by a button click.

## When an upstream download moves

`SOURCES` is the table. Everything in it is a "latest" URL or a GitHub releases
lookup except Moodle, which publishes per branch — that one number is the file's
only pin, and when it goes stale the install fails loudly with the URL in the
job log rather than quietly fetching nothing.
