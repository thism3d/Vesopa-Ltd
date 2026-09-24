#!/usr/bin/env python3
"""
The privileged half of the file manager.

Same shape, and the same reasoning, as terminal/broker.py — read that one
first if this is your introduction to either.

WHY A SEPARATE PROCESS

The website runs as an ordinary user. Reading and writing a customer's files
means acting as THEIR unix account, and nothing but root can change user. The
two bad answers are running the website as root (every bug in a route becomes a
root bug) and giving the website a blanket sudo rule (the same thing wearing a
hat). So: one small privileged program, no network socket, no dependencies, and
a list of things it will do that is short enough to read in one sitting.

    website   decides WHO is asking — a valid session, an active customer, an
              account with hosting. It never sees a uid and cannot name one.
    broker    decides WHETHER THAT IS ALLOWED, then drops to that user and lets
              the kernel enforce the rest.

THE PRIVILEGE DROP IS THE REAL SECURITY BOUNDARY. Every path check below is
worth having, but the guarantee that a customer cannot read another customer's
files comes from setuid() plus ordinary unix permissions, not from string
comparison on pathnames. The path checks stop confusion and accidents; the uid
stops attacks.

WHY THIS DOES NOT REQUIRE A SHELL

terminal/broker.py refuses an account whose Hestia package sets SHELL=nologin,
because that package has deliberately not been granted shell access. Files are
a different capability — a customer on a shell-less package still owns their
website and still has to be able to edit it — so this checks that the account
exists in Hestia and is not root, and stops there.

PROTOCOL

One operation per connection. Connect, ask, get an answer, close. No session
state, so a wedged request cannot poison the next one.

    request    [4-byte BE length][JSON]  then `body` raw bytes, if the JSON
               declares a body length
    response   [4-byte BE length][JSON]  then `body` raw bytes, where a body of
               -1 means "stream until the connection closes" (used for a zip
               whose size is not known until it has been written)
"""

import errno
import fnmatch
import grp
import io
import json
import os
import pwd
import re
import shutil
import signal
import socket
import stat as statmod
import struct
import sys
import tarfile
import time
import zipfile

SOCKET_PATH = os.environ.get("VESOPA_FILES_SOCKET", "/run/vesopa-files/broker.sock")
SOCKET_GROUP = os.environ.get("VESOPA_FILES_GROUP", "vesopasoftware")
HESTIA_USERS = "/usr/local/hestia/data/users"

# The editor loads a whole file into a textarea. Past a couple of megabytes that
# is a hostile thing to do to a browser, and the file is not one a person is
# editing by hand anyway.
MAX_EDIT = int(os.environ.get("VESOPA_FILES_MAX_EDIT", str(2 * 1024 * 1024)))

# One upload. nginx is the other limit (client_max_body_size, 1024m here) and
# the smaller of the two is what a customer actually hits.
MAX_UPLOAD = int(os.environ.get("VESOPA_FILES_MAX_UPLOAD", str(512 * 1024 * 1024)))

# A directory with more entries than this is not something anyone is browsing;
# it is a spool or a cache, and rendering it would hang the page.
MAX_ENTRIES = 5000

# Search walks the tree. Both of these stop `*` at the top of a large home from
# becoming a minute of disk IO per keystroke.
SEARCH_MAX_HITS = 300
SEARCH_MAX_SECONDS = 8.0

MAX_HEADER = 1 << 20
CHUNK = 256 * 1024


def log(msg):
    print(f"[files-broker] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Wire
# ---------------------------------------------------------------------------

def send_header(sock, obj, body=0):
    payload = json.dumps(dict(obj, body=body)).encode("utf-8")
    sock.sendall(struct.pack("!I", len(payload)) + payload)


def fail(sock, message, code="error"):
    """Every refusal looks the same on the wire: ok=false and a sentence."""
    try:
        send_header(sock, {"ok": False, "error": message, "code": code})
    except OSError:
        pass


def read_exactly(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(min(n - len(buf), CHUNK))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_request(sock):
    head = read_exactly(sock, 4)
    if not head:
        return None
    (length,) = struct.unpack("!I", head)
    if length > MAX_HEADER:
        return None
    raw = read_exactly(sock, length)
    if raw is None:
        return None
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Who
# ---------------------------------------------------------------------------

def hestia_conf(username):
    """Hestia's own record for an account, as a dict, or None."""
    conf = os.path.join(HESTIA_USERS, username, "user.conf")
    if not os.path.isfile(conf):
        return None
    out = {}
    try:
        with open(conf, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip("'\"")
    except OSError:
        return None
    return out


def resolve_user(username):
    """
    Turn a requested account name into a passwd entry it is safe to become.

    Each refusal is something the website could ask for by mistake or under
    attack, and none of them should be reachable by asking politely.
    """
    if not username or not isinstance(username, str):
        return None, "No account named."
    if len(username) > 32 or not all(c.isalnum() or c in "-_" for c in username):
        return None, "That is not a valid account name."
    if username == "root":
        return None, "Not permitted."

    # Hestia's record, not /etc/passwd: the panel is what decides which accounts
    # are hosting accounts. `info` and `ubuntu` are unix users on this box and
    # neither is a customer.
    conf = hestia_conf(username)
    if conf is None:
        return None, "No such hosting account on this server."
    if str(conf.get("SUSPENDED", "no")).lower() == "yes":
        return None, "This hosting account is suspended."

    try:
        entry = pwd.getpwnam(username)
    except KeyError:
        return None, "That account does not exist on this server."
    if entry.pw_uid == 0:
        return None, "Not permitted."
    if not os.path.isdir(entry.pw_dir):
        return None, "That account has no home directory."
    return (entry, conf), None


# ---------------------------------------------------------------------------
# Where
# ---------------------------------------------------------------------------

class Refused(Exception):
    """A request that will not be served. The message reaches the customer."""


def explain(exc):
    """
    One item's failure inside a batch, said in a sentence a customer can act on.

    `str(OSError)` is "[Errno 2] No such file or directory: '/home/u265966/x'" —
    an errno nobody outside a terminal reads, followed by the ABSOLUTE server
    path, which is neither what the customer typed nor anything they should be
    shown. `strerror` is the human half of it, with no path attached.
    """
    if isinstance(exc, Refused):
        return str(exc)
    if isinstance(exc, OSError):
        if exc.errno in (errno.EDQUOT, errno.ENOSPC):
            return "There is no space left on your account."
        if exc.errno == errno.EACCES:
            return "You do not have permission to do that."
        if exc.errno == errno.ENOENT:
            return "It is no longer there."
        if exc.errno == errno.ENOTEMPTY:
            return "That folder is not empty."
        return (exc.strerror or "That did not work") + "."
    return "That did not work."


def norm_rel(rel):
    """
    A client path, reduced to a relative path with no way out of the home.

    Leading slashes are stripped rather than rejected: the UI shows paths as
    `/web/site.com` because that is what a person expects to see, and means it
    relative to their own home. `..` is dropped entirely — not resolved, so
    `a/../../b` cannot walk above the root by arithmetic.
    """
    rel = str(rel or "").replace("\\", "/")
    parts = []
    for part in rel.split("/"):
        if part in ("", ".", ".."):
            continue
        parts.append(part)
    return "/".join(parts)


def under(home, path):
    return path == home or path.startswith(home + os.sep)


def resolve_container(home, rel):
    """
    A directory to act inside. Symlinks resolved — following a link into your
    own home is fine and useful; following one out of it is not.
    """
    target = os.path.realpath(os.path.join(home, norm_rel(rel)))
    if not under(home, target):
        raise Refused("That folder is outside your account.")
    return target


def resolve_entry(home, rel):
    """
    A single item to act ON — delete, rename, chmod, stat.

    The PARENT is resolved and checked; the last component is left alone. That
    is deliberate: `rm` on a symlink removes the link, and resolving the final
    component here would instead have us act on whatever it points at.
    """
    rel = norm_rel(rel)
    if not rel:
        raise Refused("That is your home folder — it cannot be changed here.")
    parent = os.path.realpath(os.path.join(home, os.path.dirname(rel)))
    if not under(home, parent):
        raise Refused("That path is outside your account.")
    return os.path.join(parent, os.path.basename(rel))


def resolve_content(home, rel):
    """
    An item whose CONTENT is about to be read or written.

    Here the final component is resolved too. A customer can create a symlink
    to /etc/passwd; reading it as themselves would succeed, and while that is
    not a privilege escalation — they could `cat` it from the terminal — it is
    not something the file manager should hand over as if it were theirs.
    """
    path = resolve_entry(home, rel)
    real = os.path.realpath(path)
    if not under(home, real):
        raise Refused("That file points outside your account.")
    return real


SAFE_NAME = re.compile(r"^[^/\\\x00]{1,255}$")


def check_name(name):
    """A new or renamed basename. Not a path — one component."""
    name = str(name or "").strip()
    if not SAFE_NAME.match(name) or name in (".", ".."):
        raise Refused("That name is not allowed.")
    return name


# ---------------------------------------------------------------------------
# Describing a file
# ---------------------------------------------------------------------------

TEXT_EXT = {
    "txt", "md", "markdown", "html", "htm", "css", "scss", "less", "js", "mjs",
    "cjs", "jsx", "ts", "tsx", "json", "xml", "yml", "yaml", "toml", "ini",
    "conf", "cfg", "env", "sh", "bash", "zsh", "py", "rb", "pl", "php", "sql",
    "log", "csv", "tsv", "svg", "htaccess", "gitignore", "lock", "tpl", "twig",
    "vue", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "ejs",
}
IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"}
ARCHIVE_EXT = {"zip", "gz", "tgz", "bz2", "xz", "tar", "7z", "rar"}


def ext_of(name):
    base = name.lower()
    if base.startswith(".") and base.count(".") == 1:
        return base[1:]          # .gitignore, .htaccess
    return base.rsplit(".", 1)[-1] if "." in base else ""


def describe(path, name, lst):
    kind = "dir" if statmod.S_ISDIR(lst.st_mode) else "file"
    is_link = statmod.S_ISLNK(lst.st_mode)
    row = {
        "name": name,
        "size": lst.st_size,
        "mtime": int(lst.st_mtime),
        "mode": oct(statmod.S_IMODE(lst.st_mode))[2:].zfill(3),
        "link": is_link,
    }
    if is_link:
        # A link is shown as what it points at, so a folder symlink opens like a
        # folder — but flagged, because deleting it deletes the link.
        try:
            tgt = os.stat(path)
            kind = "dir" if statmod.S_ISDIR(tgt.st_mode) else "file"
            row["size"] = tgt.st_size
        except OSError:
            kind = "file"
            row["broken"] = True
        try:
            row["target"] = os.readlink(path)
        except OSError:
            pass
    row["type"] = kind
    if kind == "file":
        e = ext_of(name)
        row["ext"] = e
        if e in IMAGE_EXT:
            row["class"] = "image"
        elif e in ARCHIVE_EXT:
            row["class"] = "archive"
        elif e in TEXT_EXT:
            row["class"] = "text"
        else:
            row["class"] = "binary"
    return row


def looks_binary(sample):
    """A NUL byte is the practical test. UTF-16 text is the false positive we
    accept — it is vanishingly rare on a web host and the editor would mangle
    it anyway."""
    return b"\0" in sample


# ---------------------------------------------------------------------------
# Operations. Every one of these runs AFTER the privilege drop.
# ---------------------------------------------------------------------------

def op_list(home, req, sock):
    rel = norm_rel(req.get("path"))
    target = resolve_container(home, rel)
    if not os.path.isdir(target):
        raise Refused("That folder does not exist.")

    show_hidden = bool(req.get("hidden"))
    entries, truncated = [], False
    with os.scandir(target) as it:
        for de in it:
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                break
            if not show_hidden and de.name.startswith("."):
                continue
            try:
                entries.append(describe(de.path, de.name, de.stat(follow_symlinks=False)))
            except OSError:
                continue

    send_header(sock, {
        "ok": True,
        "path": rel,
        "entries": entries,
        "truncated": truncated,
        "writable": os.access(target, os.W_OK),
    })


def op_read(home, req, sock):
    path = resolve_content(home, req.get("path"))
    try:
        size = os.path.getsize(path)
    except OSError:
        raise Refused("That file does not exist.")
    if size > MAX_EDIT:
        raise Refused(
            f"This file is {size // 1024} KB. The editor opens files up to "
            f"{MAX_EDIT // (1024 * 1024)} MB — download it instead."
        )
    with open(path, "rb") as fh:
        data = fh.read()
    if looks_binary(data[:8192]):
        raise Refused("That looks like a binary file, so there is nothing to edit.")
    send_header(sock, {"ok": True, "encoding": "utf-8"}, body=len(data))
    sock.sendall(data)


def op_write(home, req, sock, body):
    path = resolve_content(home, req.get("path"))
    if os.path.isdir(path):
        raise Refused("That is a folder.")
    # Written through a temp file in the same directory and renamed over, so a
    # failure part-way leaves the previous version intact rather than a half
    # file. Same directory because rename is only atomic within a filesystem.
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.vesopa-tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(body)
        if os.path.exists(path):
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    send_header(sock, {"ok": True, "size": len(body)})


def op_mkdir(home, req, sock):
    parent = resolve_container(home, req.get("path"))
    name = check_name(req.get("name"))
    target = os.path.join(parent, name)
    if os.path.lexists(target):
        raise Refused("Something with that name is already here.")
    os.mkdir(target, 0o755)
    send_header(sock, {"ok": True, "name": name})


def op_touch(home, req, sock):
    parent = resolve_container(home, req.get("path"))
    name = check_name(req.get("name"))
    target = os.path.join(parent, name)
    if os.path.lexists(target):
        raise Refused("Something with that name is already here.")
    # O_EXCL rather than open('x'): the check above races, this does not.
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    os.close(fd)
    send_header(sock, {"ok": True, "name": name})


def op_rename(home, req, sock):
    src = resolve_entry(home, req.get("path"))
    name = check_name(req.get("name"))
    dst = os.path.join(os.path.dirname(src), name)
    if not os.path.lexists(src):
        raise Refused("That item is no longer there.")
    if os.path.lexists(dst):
        raise Refused("Something with that name is already here.")
    os.rename(src, dst)
    send_header(sock, {"ok": True, "name": name})


def unique_target(dest_dir, name):
    """`report.pdf` beside a `report.pdf` becomes `report (2).pdf`."""
    candidate = os.path.join(dest_dir, name)
    if not os.path.lexists(candidate):
        return candidate
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for n in range(2, 500):
        alt = f"{stem} ({n})" + (f".{ext}" if ext else "")
        candidate = os.path.join(dest_dir, alt)
        if not os.path.lexists(candidate):
            return candidate
    raise Refused("There are too many copies of that name here already.")


def op_transfer(home, req, sock, move):
    dest = resolve_container(home, req.get("dest"))
    if not os.path.isdir(dest):
        raise Refused("That destination is not a folder.")

    done, failed = [], []
    for rel in (req.get("paths") or [])[:2000]:
        try:
            src = resolve_entry(home, rel)
            if not os.path.lexists(src):
                raise Refused("It is no longer there.")
            # Copying or moving a folder into itself builds an infinite tree.
            real_src = os.path.realpath(src)
            if os.path.isdir(real_src) and under(real_src, os.path.realpath(dest)):
                raise Refused("You cannot put a folder inside itself.")
            target = unique_target(dest, os.path.basename(src))
            if move:
                shutil.move(src, target)
            elif os.path.isdir(src) and not os.path.islink(src):
                shutil.copytree(src, target, symlinks=True)
            else:
                shutil.copy2(src, target, follow_symlinks=False)
            done.append(os.path.basename(target))
        except (Refused, OSError, shutil.Error) as exc:
            failed.append({"path": rel, "error": explain(exc)})
    send_header(sock, {"ok": True, "done": done, "failed": failed})


def op_delete(home, req, sock):
    done, failed = [], []
    for rel in (req.get("paths") or [])[:2000]:
        try:
            target = resolve_entry(home, rel)
            if os.path.islink(target) or not os.path.isdir(target):
                os.unlink(target)
            else:
                shutil.rmtree(target)
            done.append(rel)
        except (Refused, OSError) as exc:
            failed.append({"path": rel, "error": explain(exc)})
    send_header(sock, {"ok": True, "done": done, "failed": failed})


def op_chmod(home, req, sock):
    raw = str(req.get("mode") or "").strip()
    if not re.fullmatch(r"[0-7]{3,4}", raw):
        raise Refused("Permissions must be three or four digits, like 644.")
    mode = int(raw, 8)
    # setuid/setgid/sticky are not something a file manager should hand out by
    # accident, and nobody sets them from a web UI on purpose.
    if mode & (statmod.S_ISUID | statmod.S_ISGID | statmod.S_ISVTX):
        raise Refused("Setuid, setgid and sticky bits cannot be set here.")
    recursive = bool(req.get("recursive"))

    done, failed = [], []
    for rel in (req.get("paths") or [])[:2000]:
        try:
            target = resolve_entry(home, rel)
            if os.path.islink(target):
                raise Refused("Permissions on a symlink cannot be changed.")
            os.chmod(target, mode)
            if recursive and os.path.isdir(target):
                for root, dirs, names in os.walk(target):
                    for d in dirs:
                        p = os.path.join(root, d)
                        if not os.path.islink(p):
                            os.chmod(p, mode)
                    for f in names:
                        p = os.path.join(root, f)
                        if not os.path.islink(p):
                            # Files do not get the directory's execute bits: a
                            # recursive 755 over a web root is the usual reason
                            # every .php in a site becomes executable.
                            os.chmod(p, mode & ~0o111 if mode & 0o111 else mode)
            done.append(rel)
        except (Refused, OSError) as exc:
            failed.append({"path": rel, "error": explain(exc)})
    send_header(sock, {"ok": True, "done": done, "failed": failed})


def op_download(home, req, sock):
    path = resolve_content(home, req.get("path"))
    if os.path.isdir(path):
        raise Refused("That is a folder — download it as a zip instead.")
    size = os.path.getsize(path)
    send_header(sock, {"ok": True, "name": os.path.basename(path), "size": size}, body=size)
    with open(path, "rb") as fh:
        shutil.copyfileobj(fh, SocketWriter(sock), CHUNK)


class SocketWriter(io.RawIOBase):
    """A file-like wrapper so zipfile and copyfileobj can write to the socket.

    zipfile is told this is unseekable, which makes it emit data descriptors
    instead of rewriting each header — that is what allows a zip to be streamed
    without knowing any of its sizes in advance.
    """

    def __init__(self, sock):
        self._sock = sock

    def writable(self):
        return True

    def seekable(self):
        return False

    def write(self, b):
        self._sock.sendall(b)
        return len(b)


def walk_selection(home, rels):
    """
    (absolute path, name inside the archive) for everything selected.

    Directories are expanded here rather than by zipfile so that the archive
    holds relative names — a zip that unpacks as `home/u123/web/...` is a bug
    report waiting to happen.
    """
    for rel in rels[:2000]:
        try:
            src = resolve_entry(home, rel)
        except Refused:
            continue
        if not os.path.lexists(src):
            continue
        base = os.path.basename(src)
        if os.path.isdir(src) and not os.path.islink(src):
            yield src, base
            for root, dirs, names in os.walk(src):
                # Never follow a symlinked directory: a link back up the tree
                # would make the walk infinite.
                dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
                for n in dirs + names:
                    p = os.path.join(root, n)
                    yield p, os.path.join(base, os.path.relpath(p, src))
        else:
            yield src, base


def write_zip(fh, home, rels):
    with zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for abs_path, arcname in walk_selection(home, rels):
            try:
                if os.path.islink(abs_path):
                    continue
                zf.write(abs_path, arcname)
            except (OSError, ValueError):
                continue


def op_zipstream(home, req, sock):
    """Download a selection as a zip, without staging it on disk first.

    body=-1 and the connection closing is the end marker. Writing a temp file
    would give a Content-Length, at the cost of needing free space inside a
    quota that the customer may well be near.
    """
    rels = req.get("paths") or []
    if not rels:
        raise Refused("Nothing was selected.")
    name = check_name(req.get("name") or "files.zip")
    send_header(sock, {"ok": True, "name": name}, body=-1)
    write_zip(SocketWriter(sock), home, rels)


def op_compress(home, req, sock):
    """Create a zip as a file in the customer's own folder."""
    dest = resolve_container(home, req.get("dest"))
    name = check_name(req.get("name"))
    if not name.lower().endswith(".zip"):
        name += ".zip"
    target = unique_target(dest, name)
    with open(target, "wb") as fh:
        write_zip(fh, home, req.get("paths") or [])
    send_header(sock, {"ok": True, "name": os.path.basename(target)})


def safe_member(dest, member_name):
    """
    Zip Slip. An archive entry named `../../.ssh/authorized_keys` extracts
    outside the folder the customer chose unless this is checked — and on a box
    where the account has a shell, that specific example is a login.

    Absolute paths and drive letters go the same way.
    """
    name = str(member_name or "").replace("\\", "/")
    if not name or name.startswith("/") or ":" in name.split("/")[0]:
        return None
    target = os.path.realpath(os.path.join(dest, name))
    if not under(dest, target):
        return None
    return target


def op_extract(home, req, sock):
    src = resolve_content(home, req.get("path"))
    dest_rel = req.get("dest")
    dest = resolve_container(home, dest_rel) if dest_rel else os.path.dirname(src)
    if not os.path.isdir(dest):
        raise Refused("That destination is not a folder.")
    dest = os.path.realpath(dest)

    lower = src.lower()
    count, skipped = 0, 0

    if lower.endswith(".zip"):
        try:
            with zipfile.ZipFile(src) as zf:
                for info in zf.infolist():
                    target = safe_member(dest, info.filename)
                    if target is None:
                        skipped += 1
                        continue
                    if info.is_dir():
                        os.makedirs(target, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with zf.open(info) as srcf, open(target, "wb") as dstf:
                        shutil.copyfileobj(srcf, dstf, CHUNK)
                    count += 1
        except zipfile.BadZipFile:
            raise Refused("That zip file is damaged and cannot be opened.")

    elif any(lower.endswith(s) for s in (".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")):
        try:
            with tarfile.open(src) as tf:
                for member in tf:
                    target = safe_member(dest, member.name)
                    if target is None:
                        skipped += 1
                        continue
                    # Links inside a tar are the same escape as a `..` name,
                    # one indirection later. Not worth supporting.
                    if member.issym() or member.islnk() or member.isdev():
                        skipped += 1
                        continue
                    if member.isdir():
                        os.makedirs(target, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    extracted = tf.extractfile(member)
                    if extracted is None:
                        skipped += 1
                        continue
                    with extracted as srcf, open(target, "wb") as dstf:
                        shutil.copyfileobj(srcf, dstf, CHUNK)
                    count += 1
        except tarfile.TarError:
            raise Refused("That archive is damaged and cannot be opened.")
    else:
        raise Refused("Only .zip, .tar, .tar.gz, .tar.bz2 and .tar.xz can be unpacked here.")

    send_header(sock, {"ok": True, "extracted": count, "skipped": skipped})


def op_search(home, req, sock):
    root = resolve_container(home, req.get("path"))
    query = str(req.get("query") or "").strip()
    if len(query) < 2:
        raise Refused("Type at least two characters to search for.")
    # A plain word means "contains that word"; anyone who types * or ? gets the
    # glob they were reaching for.
    pattern = query.lower() if any(c in query for c in "*?[") else f"*{query.lower()}*"

    hits, started, stopped = [], time.time(), False
    for dirpath, dirs, names in os.walk(root):
        if time.time() - started > SEARCH_MAX_SECONDS or len(hits) >= SEARCH_MAX_HITS:
            stopped = True
            break
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(dirpath, d))]
        for name in dirs + names:
            if not fnmatch.fnmatch(name.lower(), pattern):
                continue
            full = os.path.join(dirpath, name)
            try:
                row = describe(full, name, os.lstat(full))
            except OSError:
                continue
            row["path"] = os.path.relpath(full, home)
            row["dir"] = os.path.relpath(dirpath, home)
            if row["dir"] == ".":
                row["dir"] = ""
            hits.append(row)
            if len(hits) >= SEARCH_MAX_HITS:
                stopped = True
                break

    send_header(sock, {"ok": True, "entries": hits, "truncated": stopped})


def op_upload(home, req, sock, body):
    parent = resolve_container(home, req.get("path"))
    name = check_name(req.get("name"))
    target = os.path.join(parent, name)
    if req.get("overwrite"):
        if os.path.isdir(target) and not os.path.islink(target):
            raise Refused("A folder with that name is already here.")
    else:
        target = unique_target(parent, name)
    with open(target, "wb") as fh:
        fh.write(body)
    os.chmod(target, 0o644)
    send_header(sock, {"ok": True, "name": os.path.basename(target), "size": len(body)})


OPS_WITH_BODY = {"write", "upload"}

HANDLERS = {
    "list": op_list,
    "read": op_read,
    "mkdir": op_mkdir,
    "touch": op_touch,
    "rename": op_rename,
    "delete": op_delete,
    "chmod": op_chmod,
    "download": op_download,
    "zipstream": op_zipstream,
    "compress": op_compress,
    "extract": op_extract,
    "search": op_search,
    "move": lambda home, req, sock: op_transfer(home, req, sock, move=True),
    "copy": lambda home, req, sock: op_transfer(home, req, sock, move=False),
}


# ---------------------------------------------------------------------------
# One connection
# ---------------------------------------------------------------------------

def run_request(conn):
    conn.settimeout(60)
    req = read_request(conn)
    if req is None:
        return

    op = str(req.get("op") or "")
    resolved, why = resolve_user(req.get("user"))
    if not resolved:
        log(f"refused {req.get('user')!r} for {op!r}: {why}")
        fail(conn, why, "forbidden")
        return
    entry, conf = resolved

    if op not in HANDLERS and op not in OPS_WITH_BODY:
        fail(conn, "That operation is not supported.")
        return

    # The request body is read BEFORE the privilege drop only in the sense that
    # it is read on this socket; it is never interpreted as a path or a command.
    body = b""
    if op in OPS_WITH_BODY:
        declared = int(req.get("body") or 0)
        limit = MAX_UPLOAD if op == "upload" else MAX_EDIT
        if declared < 0 or declared > limit:
            fail(conn, "That file is too large.")
            return
        conn.settimeout(300)   # a big upload over a slow line is not a hang
        body = read_exactly(conn, declared) if declared else b""
        if body is None:
            return
        conn.settimeout(60)

    # ---- drop, act ---------------------------------------------------------
    # This process is already a per-connection child (see main), and it exits at
    # the end of this function. That is what makes the drop irreversible: a
    # setuid() in a long-lived root process could be undone, and nothing here
    # must ever be able to act as two different customers.
    try:
        os.setgid(entry.pw_gid)
        os.initgroups(entry.pw_name, entry.pw_gid)
        os.setuid(entry.pw_uid)
        if os.getuid() == 0 or os.geteuid() == 0:
            os._exit(1)
        os.umask(0o022)
    except Exception:
        fail(conn, "Could not switch to that account.")
        os._exit(1)

    home = os.path.realpath(entry.pw_dir)
    try:
        if op in OPS_WITH_BODY:
            (op_write if op == "write" else op_upload)(home, req, conn, body)
        else:
            HANDLERS[op](home, req, conn)
    except Refused as exc:
        fail(conn, str(exc), "refused")
    except PermissionError:
        fail(conn, "You do not have permission to do that here.", "denied")
    except FileNotFoundError:
        fail(conn, "That file or folder no longer exists.", "missing")
    except FileExistsError:
        fail(conn, "Something with that name is already here.", "exists")
    except OSError as exc:
        if exc.errno in (errno.EDQUOT, errno.ENOSPC):
            fail(conn, "There is no space left on your account.", "quota")
        else:
            fail(conn, f"That did not work: {exc.strerror or exc}.")
    except Exception as exc:                       # never leak a traceback
        log(f"{op} failed for {entry.pw_name}: {exc}")
        fail(conn, "Something went wrong handling that file.")
    finally:
        try:
            conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        os._exit(0)


def main():
    if os.geteuid() != 0:
        log("must run as root — changing user is the whole point")
        sys.exit(1)

    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)

    # The socket permissions ARE the access control — see terminal/broker.py for
    # the full argument. 0660 root:<web group>. Not 0666: every customer on this
    # box has a shell, and 0666 would let any of them ask for any other
    # customer's files.
    try:
        gid = grp.getgrnam(SOCKET_GROUP).gr_gid
        os.chown(SOCKET_PATH, 0, gid)
        os.chmod(SOCKET_PATH, 0o660)
    except KeyError:
        log(f"group {SOCKET_GROUP!r} does not exist — refusing to open the socket to everyone")
        sys.exit(1)

    server.listen(32)
    log(f"listening on {SOCKET_PATH}")

    # Children are reaped by the kernel rather than waited for: this loop must
    # not block, and it has nothing to learn from an exit status.
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)

    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            continue
        # One process per request. A 400 MB upload holds a whole child for as
        # long as it takes and no other customer waits on it; a request that
        # wedges takes nothing with it when it is killed.
        if os.fork() == 0:
            server.close()
            try:
                run_request(conn)
            except Exception as exc:
                log(f"request error: {exc}")
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
            os._exit(0)
        conn.close()


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    main()
