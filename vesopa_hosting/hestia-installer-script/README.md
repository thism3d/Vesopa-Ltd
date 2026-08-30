# Vesopa Hosting — control panel installer

`vesopa-hestia-install.sh` is **our** installer. It started as HestiaCP's
`hst-install-ubuntu.sh` and is maintained here from now on.

`upstream-reference/hst-install-ubuntu.sh` is the frozen copy it was forked
from, kept only so that

```bash
diff -u upstream-reference/hst-install-ubuntu.sh vesopa-hestia-install.sh
```

always shows exactly what we changed. Every edit is also marked `VESOPA:` in
place, next to the line it fixes.

## The command

On a **fresh** Ubuntu 24.04 LTS box, as root:

```bash
sudo -i
bash vesopa-hestia-install.sh \
  --hostname 'vesopa.com' \
  --username 'vesopa' \
  --email 'muzahid@vesopa.com' \
  --password 'YOUR-PASSWORD' \
  --port '2083' \
  --multiphp '7.4,8.3' \
  --vsftpd no \
  --proftpd yes \
  --postgresql yes \
  --sieve yes \
  --quota yes \
  --webterminal yes \
  --interactive no \
  --force
```

Then **reboot** — see "About the prompts" below for why that is now manual.

Two differences from the command that failed before:

- `bash vesopa-hestia-install.sh`, not `bash hst-install.sh`. That wrapper is
  deleted on purpose. Its only job was
  `wget -O hst-install-ubuntu.sh …` — it overwrites whatever is on disk with
  upstream's copy, every run, with no prompt. Running it would silently undo
  every fix in this directory before the install started.
- `--interactive no` is added. Without it you get asked two questions.

`--multiphp '7.4, 8.3'` with the space also works — the installer word-splits an
unquoted expansion, so it parses to two versions either way. The comma form just
does not rely on that.

## About the prompts you had to answer

`interactive` defaults to `yes` (upstream `set_default_value` line), and the
original command did not override it, so two prompts fired:

| Prompt | Fixed by |
| --- | --- |
| `Would you like to continue with the installation? [y/N]` | `--interactive no` |
| `Press any key to continue` — then it reboots | `--interactive no` |
| `Would you like to continue without netplan? [Y/n]` | edit 11, answered automatically |

The netplan one is worth calling out: it is covered by **neither**
`--interactive` **nor** `--force`, so it hangs an unattended run on any image
configured through systemd-networkd or a cloud guest agent — which is most GCE
and EC2 images. Its default was already "continue", so answering it
automatically changes no outcome.

The fourth confirmation in there — `Would you like to remove the conflicting
packages? [y/N]` — is already skipped by `--force`, which the original command
did pass. It was never the one asking.

**`--interactive no` means the installer no longer reboots for you.** It prints
that a restart is needed and stops. Quota and several service units are only
correct after that reboot, so do it.

## After the install — do these two things

### 1. Reboot. It is not optional.

`--interactive no` means the installer does not reboot for you; it prints
`IMPORTANT: You must restart the system before continuing!` and stops. Several
things are only correct after that restart, quota among them.

```bash
reboot
```

### 2. Check that quota actually came on

A first install on GCP ends with this, and the installer prints it and carries
on regardless:

```
quotaon: using //aquota.group on /dev/root [/]: No such process
quotaon: Quota format not supported in kernel.
Error: quota can't be enabled in /
```

This is expected AT INSTALL TIME: `v-add-sys-quota` adds `usrquota,grpquota` to
the root filesystem in `/etc/fstab`, but a filesystem cannot start enforcing
quota until it is remounted with those options — which is what the reboot is
for. It is not expected to still be failing afterwards.

It matters because `DISK_QUOTA=yes` is already written into `hestia.conf`, so
the panel believes quota is on. If the filesystem is not enforcing it, **every
plan's disk limit is advisory** — a starter account can fill the disk and
nothing stops it. That is a silent failure, which is why it is worth one command
to check:

```bash
# After the reboot:
quotaon -p /            # want: user quota on /dev/... is on
repquota -s /   | head  # want: a table, not an error
```

If it is still off, the root filesystem did not come back with the quota
options. Confirm they are there and that the running kernel supports the format:

```bash
grep ' / ' /etc/fstab     # want usrquota,grpquota in the options
mount | grep ' / '        # want the same, on the live mount
uname -r                  # GCP boots a -gcp kernel; the installer also pulls in
                          # linux-image-generic for quota support
```

If `/etc/fstab` is right but the live mount is not, `mount -o remount /` then
`v-add-sys-quota` again. If the kernel is the problem, boot the generic kernel
GRUB now lists, or accept that quota is off and enforce disk limits some other
way — but do not leave `DISK_QUOTA=yes` in `hestia.conf` claiming otherwise.

## Building a second, identical server

Same command, **one thing must change: the hostname.**

Two panels answering to the same FQDN collide on the things that are keyed to a
name rather than an IP — the Let's Encrypt certificate for the panel, the DNS
record, and exim's HELO, which mail providers will hold against you. Give the
second box its own name (`hosting2.vesopa.com`) and point DNS at it before
running the installer, so the panel certificate can be issued.

Everything else — ports, PHP versions, service choices — stays byte for byte the
same, which is the point of having this file.

## What was actually wrong

### 1. systemd-timesyncd — the error that stopped the first attempt

Upstream:

```bash
if [[ "$release" = "22.04" ]] || [[ "$release" = "24.04" ]]; then
    sed -i 's/#NTP=/NTP=pool.ntp.org/' /etc/systemd/timesyncd.conf
    systemctl enable systemd-timesyncd
    systemctl start systemd-timesyncd
fi
```

It treats "the release is 24.04" as proof that `systemd-timesyncd` is installed.
It is not. In 24.04 timesyncd is a **separate package**, split out of systemd,
and it is absent from the cloud and minimal images GCP and AWS actually boot.
Verified on a running 24.04 host: no package, no unit file, and no
`/etc/systemd/timesyncd.conf`. So both lines fail:

```
sed: can't read /etc/systemd/timesyncd.conf: No such file or directory
Failed to enable unit: Unit file systemd-timesyncd.service does not exist.
```

Upstream's own comment on the line above admits the package is not guaranteed
("26.04 … uses Chrony"). They just wrote the check for the wrong release.

Our version installs a time client instead of assuming one: use whatever is
already synchronising the clock, else install `systemd-timesyncd`, else
`chrony`, else warn and carry on. It never aborts — a drifting clock hurts DKIM,
TOTP logins and Let's Encrypt, but it is not a reason to refuse to build a
server.

### 2. The "folder" errors — commands that succeed exactly once

This is one bug wearing several hats, and it is why the **second** run failed
differently from the first. The installer has no `set -e`, so the timesyncd
failure did not stop it — it printed the error and carried on building a partial
system. Re-running then hit everything the first run had already created:

| Line | Command | Second-run failure |
| --- | --- | --- |
| `mkdir nginx apache2 …` | no `-p` | `cannot create directory: File exists` |
| `mkdir spamassassin mysql …` | no `-p` | same |
| `mkdir /usr/share/phpmyadmin/tmp` | no `-p` | same |
| `ln -s /var/log/hestia $HESTIA/log` | no `-f` | `failed to create symbolic link: File exists` |
| `ln -s …/config.inc.php` ×2, `ln -s exim4 mta` | no `-f` | same |
| `useradd hestiaweb` | unguarded | `user 'hestiaweb' already exists` |
| `useradd hestiamail` | unguarded | same |

All are now idempotent. The `hestia-users` group created between the two
`useradd` calls *is* guarded upstream, which is how you can tell the two users
were an oversight rather than a decision.

Two unchecked `cd`s were also fixed, and these were the dangerous ones:

- `cd $hst_backups` then bare `mkdir nginx …` — a failed `cd` scatters
  directories called `nginx`, `mysql` and so on into whatever directory you
  launched the installer from.
- `cd $HESTIA/ssl` — everything after it writes with **relative paths**, so a
  failed `cd` puts the panel's certificate and its **private key** in the
  current directory instead.

### 3. The version gate — the one that would have made forking pointless

Upstream fetched `src/deb/hestia/control` from their release branch **at install
time** and refused to run unless this script's version matched whatever was on
that branch at that moment. So a pinned copy stops installing the day HestiaCP
bump their branch — with a message telling you to re-download their script,
which would throw away every fix here. And if GitHub is unreachable the lookup
returns empty, the comparison fails, and the install aborts on a network blip.

It now warns and continues. Set `HESTIA_STRICT_VERSION=yes` to restore the
abort.

## What is still not ours

Owning this script does not own the software it installs. The panel is `.deb`
packages from `apt.hestiacp.com`. `RHOST` is now overridable:

```bash
HESTIA_APT_HOST=apt.vesopa.com bash vesopa-hestia-install.sh …
```

To own the base properly, either mirror that apt repository or build the debs
and pass `--with-debs /path`. Until then the script is ours and the packages are
still theirs — and while they float, the version notice above is expected.

## Maintenance

When you want a newer HestiaCP:

1. Download their current `hst-install-ubuntu.sh` into `upstream-reference/`.
2. `diff` it against the old frozen copy to see what they changed.
3. Re-apply our `VESOPA:` edits onto the new file.
4. `bash -n vesopa-hestia-install.sh` before it goes anywhere near a server.

## Status

Verified: both files are valid bash under GNU bash on Ubuntu 24.04, the edited
installer loads and parses its arguments, and all 15 `VESOPA:` edits are present.

**Not verified: a full install.** That needs a throwaway Ubuntu 24.04 VM, and
the existing production server was deliberately left alone. Run it on the new
box first and send the log if anything stops.
