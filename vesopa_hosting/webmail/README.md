# One-click webmail

Opening a mailbox from the panel without typing a second password.

## The shape of it

    panel      signs a short-lived, single-use link and redirects the browser
    plugin     verifies it, spends the nonce, and logs the mailbox in
    Dovecot    opens that mailbox for a MASTER user, with no mailbox password

Three files:

| File | Goes to | What it is |
|---|---|---|
| `vesopa_sso/` | `/var/lib/roundcube/plugins/vesopa_sso/` | The Roundcube plugin |
| `auth-vesopa-master.conf.ext` | `/etc/dovecot/conf.d/` | The master passdb |
| `install-sso.sh` | run on the node as root | Puts both in place and mints the secrets |

## Why not the sealed-password vault it replaces

`src/mailbox-vault.js` kept an encrypted copy of the mailbox password and
replayed it into Roundcube's login form. It was honest about its own limits and
they were fatal in practice:

- **Opt-in, so almost nobody had it.** A row existed only where the customer had
  typed the password into our form. Every mailbox made before the feature, or on
  the node, or changed elsewhere, simply fell through to the login page — which
  is the complaint that started this.
- **We held a credential we had no business holding.** Defensible, argued at
  length in that file, and still worse than not holding it.

Master-user authentication needs no copy of anything. The vault remains as a
fallback for a node where this is not installed, and stores nothing new.

## Why a nonce and not an IP

Hestia's phpMyAdmin handoff binds its token to the visitor's IP *as the node's
PHP computes it* — which depends on how the app is fronted, cannot be known from
the panel, and has a configuration setting whose only job is guessing it right.
Guess wrong and every customer lands on a login form.

A nonce spent on first use is strictly stronger — a captured link cannot be
replayed even from the same address — and there is nothing to guess. Links live
sixty seconds and die on use.

## Installing

    scp -r webmail root@node:/tmp/vesopa-webmail
    ssh root@node 'bash /tmp/vesopa-webmail/install-sso.sh'

It prints one line to paste into the panel's `.env`:

    WEBMAIL_SSO_KEY=<64 hex characters>

Then restart the panel. Without that key the panel signs nothing, the plugin
refuses everything, and every mailbox link goes to the ordinary login page —
which is where things stood before any of this existed. Nothing half-works.

## Checking it

    systemctl status dovecot
    doveadm auth test -x service=imap -M vesopasso muzahid@vesopa.com '<master password>'
    tail -f /var/log/roundcube/vesopa_sso   # the plugin logs every refusal, with a reason

`refused: bad signature` means the panel and the plugin disagree about the key.
`refused: link already used` on a first click means something is prefetching the
link — a browser preview or a security scanner opening it before the customer.

## Rotating

Re-run the installer. It mints a new key and a new master password, rewrites
both config files and restarts Dovecot. In-flight links break; nothing else
does. The panel needs the new `WEBMAIL_SSO_KEY`.
