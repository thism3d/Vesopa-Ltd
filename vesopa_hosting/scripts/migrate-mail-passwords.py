#!/usr/bin/env python3
"""Carry mailbox passwords from another Hestia box, hash for hash.

    migrate-mail-passwords.py OLD_USER_CONF NEW_USER NEW_DOMAIN

    OLD_USER_CONF   a copy of the OLD box's /usr/local/hestia/data/users/<u>/mail/<domain>.conf
    NEW_USER        the account on THIS box that now holds the domain
    NEW_DOMAIN      the mail domain

Hestia keeps a mailbox's password in two places and both have to agree: the
Dovecot passwd file (/home/<user>/conf/mail/<domain>/passwd, field 2) and the
MD5= field of the account's line in the user's mail conf, which is what
v-rebuild-mail-domains writes the passwd file FROM. A hash written into only
one of them lasts until the next rebuild.

Runs here, on the box, with the hashes read from files and written to files —
never through a shell. A bcrypt hash is full of `$2y$05$…`, and any shell that
sees one unquoted turns `$2` and `$0` into nothing and its own name; the first
attempt at this migration produced `ybash5/…`, which is what that looks like.
"""

import re
import sys

old_conf, user, domain = sys.argv[1:4]

hashes = {}
for line in open(old_conf, encoding="utf-8", errors="replace"):
    m = re.search(r"ACCOUNT='([^']*)'.*?MD5='([^']*)'", line)
    if m and m.group(2):
        hashes[m.group(1)] = m.group(2)

if not hashes:
    print("no hashes found in", old_conf)
    sys.exit(1)

conf_path = f"/usr/local/hestia/data/users/{user}/mail/{domain}.conf"
passwd_path = f"/home/{user}/conf/mail/{domain}/passwd"

# 1. Hestia's record.
lines = open(conf_path, encoding="utf-8").read().splitlines()
changed = 0
for i, line in enumerate(lines):
    m = re.search(r"ACCOUNT='([^']*)'", line)
    if m and m.group(1) in hashes:
        new = re.sub(r"MD5='[^']*'", "MD5='" + hashes[m.group(1)] + "'", line)
        if new != line:
            lines[i] = new
            changed += 1
open(conf_path, "w", encoding="utf-8").write("\n".join(lines) + "\n")

# 2. Dovecot's file, field 2 only — uid, gid, home and quota stay this box's.
rows = open(passwd_path, encoding="utf-8").read().splitlines()
fixed = 0
for i, row in enumerate(rows):
    parts = row.split(":")
    if parts and parts[0] in hashes and len(parts) > 1:
        parts[1] = hashes[parts[0]]
        rows[i] = ":".join(parts)
        fixed += 1
open(passwd_path, "w", encoding="utf-8").write("\n".join(rows) + "\n")

print(f"{domain}: {changed} hash(es) recorded, {fixed} written for dovecot, of {len(hashes)} on the old box")
