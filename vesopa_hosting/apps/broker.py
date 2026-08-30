#!/usr/bin/env python3
"""
The privileged half of applications and runtimes.

The third broker. Read terminal/broker.py first for the argument, and
files/broker.py for the wire format — both are the same here.

    website   decides WHO is asking — a valid session, an active customer, an
              account with hosting. It never sees a uid and cannot name one.
    broker    decides WHETHER THAT IS ALLOWED, then drops to that user and lets
              the kernel enforce the rest.

WHAT MAKES THIS ONE DIFFERENT, and therefore what it is careful about:

  IT RUNS PROGRAMS. The other two read files and open shells. This one runs
  npm, composer, tar and pm2. So the website never sends a command — it sends
  an OPERATION NAME and validated arguments, and the recipes live here, in
  RECIPES, where they can be read in one sitting. There is no op that takes a
  string and runs it. If you are adding one, don't.

  AN INSTALL IS A JOB. `composer create-project` takes minutes. The request
  returns as soon as the job is accepted; a forked child does the work and
  writes progress to the account's own home, which the panel polls. A customer
  closing the tab changes nothing.

  NOTHING IS BUILT IN PLACE. Every install assembles under ~/.vesopa/build/<id>
  and is moved into the document root only once it has succeeded. A failed
  install therefore leaves the site exactly as it was, rather than half a
  framework and a broken index. This is the single most important property in
  the file: an installer that can half-work is worse than no installer.

  THE CATALOGUE IS A CONTRACT. src/app-catalogue.js has the same slugs and the
  presentation for each. Add an app in one place only and it either cannot be
  reached or fails when clicked. `npm run check:apps` checks the two lists.
"""

import errno
import grp
import json
import os
import pwd
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.request

SOCKET_PATH = os.environ.get("VESOPA_APPS_SOCKET", "/run/vesopa-apps/broker.sock")
SOCKET_GROUP = os.environ.get("VESOPA_APPS_GROUP", "vesopasoftware")
HESTIA_USERS = "/usr/local/hestia/data/users"
HESTIA_BIN = "/usr/local/hestia/bin"
HESTIA_TEMPLATES = "/usr/local/hestia/data/templates/web/php-fpm"
NODE_ROOT = os.environ.get("VESOPA_NODE_ROOT", "/opt/nodejs")

MAX_HEADER = 1 << 20
CHUNK = 256 * 1024

# Where a job keeps its progress, inside the customer's own home. Their home
# rather than /var/lib for one reason: it is subject to their disk quota, so a
# runaway install log is their megabyte and not the machine's.
STATE_DIR = ".vesopa"

# How long any one step in a recipe may take. npm install on a cold cache with
# a big dependency tree is genuinely slow, and killing it at 60s would fail
# every Strapi install on the box.
STEP_TIMEOUT = int(os.environ.get("VESOPA_APPS_STEP_TIMEOUT", "900"))

# A whole install. Past this something is wrong rather than slow.
JOB_TIMEOUT = int(os.environ.get("VESOPA_APPS_JOB_TIMEOUT", "2400"))


def log(msg):
    print(f"[apps-broker] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Wire
# ---------------------------------------------------------------------------

def send(sock, obj):
    payload = json.dumps(obj).encode("utf-8")
    try:
        sock.sendall(struct.pack("!I", len(payload)) + payload)
    except OSError:
        pass


def fail(sock, message, code="error"):
    send(sock, {"ok": False, "error": message, "code": code})


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


class Refused(Exception):
    """A request that will not be served. The message reaches the customer."""


# ---------------------------------------------------------------------------
# Who
# ---------------------------------------------------------------------------

def hestia_conf(username):
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


def hestia_web_domains(username):
    """
    This account's websites, straight out of Hestia's own record.

    Root-only, so it is read BEFORE the privilege drop and carried across as
    plain data. Each entry carries the FPM template — `PHP-8_3` — which is the
    only place the site's PHP version is actually recorded.
    """
    path = os.path.join(HESTIA_USERS, username, "web.conf")
    sites = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line.startswith("DOMAIN="):
                    continue
                fields = dict(re.findall(r"([A-Z_0-9]+)='([^']*)'", line))
                name = fields.get("DOMAIN")
                if name:
                    sites[name] = fields
    except OSError:
        pass
    return sites


PHP_ROOT = "/etc/php"


def php_pools():
    """
    Which PHP version each website is ACTUALLY served by.

    Read from `/etc/php/<version>/fpm/pool.d/<domain>.conf`, not from the
    template name in Hestia's web.conf, because on this node every site's
    BACKEND is the string `default` — the stock template, whose `listen` line
    is `php%backend_version%-fpm-%domain%.sock`. Parsing the template name gave
    None for every site, so the panel showed "we could not read which PHP this
    site is on" for a whole account that was plainly running 8.3.

    The pool file is where the answer really lives: one exists per site, under
    the directory of the version serving it. A site switched with
    v-change-web-domain-backend-tpl moves between those directories, so this
    stays right afterwards too.
    """
    out = {}
    try:
        versions = os.listdir(PHP_ROOT)
    except OSError:
        return out
    for version in versions:
        pool = os.path.join(PHP_ROOT, version, "fpm", "pool.d")
        try:
            for name in os.listdir(pool):
                if name.endswith(".conf") and name != "www.conf":
                    out[name[:-5]] = version
        except OSError:
            continue
    return out


def resolve_user(username):
    """
    Turn a requested account name into a passwd entry it is safe to become.

    Identical to the file broker's, and deliberately not shared with it: these
    are two programs that must be independently readable, and a common library
    between privileged halves is a common place to get both wrong at once.
    """
    if not username or not isinstance(username, str):
        return None, "No account named."
    if len(username) > 32 or not all(c.isalnum() or c in "-_" for c in username):
        return None, "That is not a valid account name."
    if username == "root":
        return None, "Not permitted."

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
# What the machine has
# ---------------------------------------------------------------------------

def php_templates():
    """
    The PHP versions this node can serve, from Hestia's FPM templates.

    The templates are the truth rather than /usr/bin/php*: a binary with no
    template cannot be selected for a website, and a template with no binary is
    a broken node. Reading the directory answers the question the panel is
    actually asking — "which of these may I choose?".
    """
    out = []
    try:
        names = os.listdir(HESTIA_TEMPLATES)
    except OSError:
        return out
    for name in sorted(names):
        m = re.fullmatch(r"(PHP-(\d+)_(\d+))\.tpl", name)
        if not m:
            continue
        version = f"{m.group(2)}.{m.group(3)}"
        out.append({
            "template": m.group(1),
            "version": version,
            "binary": f"/usr/bin/php{version}",
        })
    return out


def node_lines():
    """
    Node versions installed side by side under /opt/nodejs.

    Laid out by hestia-node-install as /opt/nodejs/<major>/bin/node. The exact
    version is asked of the binary rather than parsed out of the directory name,
    because the directory is a major and a customer wants to see 22.14.0.
    """
    out = []
    try:
        # NUMERIC DIRECTORY NAMES ONLY. The node also has /opt/nodejs/default,
        # a symlink to whichever line is current — a real directory with a real
        # bin/node in it, which without this filter is offered to customers as
        # a Node version called "default" and stored as one.
        majors = sorted(
            (n for n in os.listdir(NODE_ROOT) if n.isdigit()),
            key=int,
        )
    except OSError:
        return out
    for major in majors:
        binary = os.path.join(NODE_ROOT, major, "bin", "node")
        if not os.path.isfile(binary):
            continue
        version = ""
        try:
            version = subprocess.run(
                [binary, "-v"], capture_output=True, text=True, timeout=10,
            ).stdout.strip().lstrip("v")
        except (OSError, subprocess.SubprocessError):
            pass
        out.append({"major": int(major), "version": version,
                    "bin": os.path.dirname(binary)})
    return out


def default_node():
    lines = node_lines()
    if not lines:
        return None
    # The newest LTS is the sane default, and even majors are the LTS line.
    even = [n for n in lines if n["major"] % 2 == 0]
    return (even or lines)[-1]


def find_pm2():
    for candidate in ("/opt/pm2/bin/pm2", "/usr/local/bin/pm2", "/usr/bin/pm2"):
        if os.path.isfile(candidate):
            return candidate
    return shutil.which("pm2")


# ---------------------------------------------------------------------------
# Running things, as the customer
# ---------------------------------------------------------------------------

def user_env(home, node=None, extra=None):
    """
    A clean environment for a customer's process.

    Built rather than inherited: this process's environment belongs to a root
    daemon, and passing it down would hand a customer's npm scripts whatever
    systemd put there. PATH names the Node line explicitly so that `npm` and
    `node` inside a recipe are the version the customer chose and not whatever
    happens to be first on the system path.
    """
    path = "/usr/local/bin:/usr/bin:/bin"
    if node and node.get("bin"):
        path = f"{node['bin']}:{path}"
    env = {
        "HOME": home,
        "PATH": path,
        "SHELL": "/bin/bash",
        "LANG": "C.UTF-8",
        "PM2_HOME": os.path.join(home, ".pm2"),
        # npm writes its cache and logs somewhere; without this it picks /root
        # from HOME's absence and fails with EACCES on a fresh account.
        "npm_config_cache": os.path.join(home, ".npm"),
        "npm_config_update_notifier": "false",
        "npm_config_fund": "false",
        "npm_config_audit": "false",
        "CI": "1",
    }
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env


def sh(argv, cwd=None, env=None, timeout=STEP_TIMEOUT, check=True):
    """
    One program, as an argv list. Never a shell string.

    `shell=True` is not used anywhere in this file and should not start being
    used: every argument that reaches here has passed through a validator, and
    a shell would put all that work behind one unquoted variable.
    """
    try:
        done = subprocess.run(
            argv, cwd=cwd, env=env, capture_output=True, text=True,
            timeout=timeout, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise Refused(f"`{os.path.basename(argv[0])}` took longer than {timeout} seconds and was stopped.")
    except OSError as exc:
        raise Refused(f"Could not run {os.path.basename(argv[0])}: {exc.strerror or exc}.")
    output = (done.stdout or "") + (done.stderr or "")
    if check and done.returncode != 0:
        tail = "\n".join(output.strip().splitlines()[-12:])
        raise Refused(f"`{os.path.basename(argv[0])}` failed:\n{tail}")
    return done.returncode, output


# ---------------------------------------------------------------------------
# pm2
# ---------------------------------------------------------------------------

def pm2_list(home, probe=True):
    """
    The account's processes, and whether each is really working.

    `pm2 jlist` is the machine-readable list. Everything after it is the part
    that matters: a probe of the port. pm2 says "online" about a process that
    exists, which is not the same claim as "your site works", and the panel
    that prints the first while meaning the second is lying to the customer.
    """
    pm2 = find_pm2()
    if not pm2:
        return []
    env = user_env(home)
    rc, out = sh([pm2, "jlist"], cwd=home, env=env, timeout=30, check=False)
    if rc != 0:
        return []
    # pm2 occasionally prints a notice before the JSON, so the whole output is
    # tried first and the bracket is the fallback rather than the rule — taking
    # the first "[" unconditionally would find one inside a warning.
    raw = None
    for candidate in (out, out[out.index("["):] if "[" in out else ""):
        try:
            raw = json.loads(candidate)
            break
        except ValueError:
            continue
    if not isinstance(raw, list):
        return []

    apps = []
    for item in raw:
        pm = item.get("pm2_env") or {}
        port = pm.get("PORT") or (pm.get("env") or {}).get("PORT")
        try:
            port = int(port)
        except (TypeError, ValueError):
            port = None
        started = pm.get("pm_uptime") or 0
        app = {
            "name": item.get("name"),
            "domain": pm.get("VESOPA_DOMAIN") or item.get("name"),
            "status": pm.get("status"),
            "pid": item.get("pid"),
            "port": port,
            "node": pm.get("node_version") or "",
            "script": os.path.basename(pm.get("pm_exec_path") or "") or pm.get("script") or "",
            "cwd": pm.get("pm_cwd") or "",
            "uptime_ms": max(0, int(time.time() * 1000) - int(started)) if started else 0,
            "restarts": int(pm.get("restart_time") or 0),
            "unstable_restarts": int(pm.get("unstable_restarts") or 0),
            "cpu": (item.get("monit") or {}).get("cpu", 0),
            "memory_mb": round(((item.get("monit") or {}).get("memory", 0)) / (1024 * 1024), 1),
        }
        if probe and port and app["status"] == "online":
            app["probe"] = http_probe(port)
        apps.append(app)
    return apps


def http_probe(port, timeout=2.5):
    """
    Does anything answer on that port, and how fast.

    A plain GET to 127.0.0.1. ANY HTTP response counts as answering, including
    a 500: the question here is whether the process is serving, not whether the
    customer's code is correct. A 404 from a Next.js app with no index page is
    a working app, and telling somebody it is broken would be wrong.
    """
    start = time.time()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as conn:
            conn.settimeout(timeout)
            conn.sendall(
                b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n"
                b"User-Agent: vesopa-health/1\r\n\r\n"
            )
            first = conn.recv(64)
    except (socket.timeout, TimeoutError):
        return {"ok": False, "error": "timeout", "ms": int((time.time() - start) * 1000)}
    except ConnectionRefusedError:
        return {"ok": False, "error": "refused", "ms": int((time.time() - start) * 1000)}
    except OSError:
        return {"ok": False, "error": "refused", "ms": int((time.time() - start) * 1000)}

    ms = int((time.time() - start) * 1000)
    m = re.match(rb"HTTP/1\.[01] (\d{3})", first or b"")
    if not m:
        # Something is listening but it is not speaking HTTP. Still "answering"
        # in the sense that matters — the process is alive and bound.
        return {"ok": bool(first), "status": None, "ms": ms,
                "error": None if first else "refused"}
    return {"ok": True, "status": int(m.group(1)), "ms": ms}


def pm2_app(home, name):
    for app in pm2_list(home, probe=False):
        if app.get("name") == name:
            return app
    return None


def clean_app_name(name):
    """
    A pm2 process name, as this panel creates them: the domain.

    Validated rather than trusted because it becomes an argv element. The
    alphabet is a hostname's, which is all the wrapper ever creates.
    """
    name = str(name or "").strip().lower()
    if not name or len(name) > 253:
        raise Refused("That is not an application name.")
    if not re.fullmatch(r"[a-z0-9]([a-z0-9._-]*[a-z0-9])?", name):
        raise Refused("That is not an application name.")
    return name


def clean_domain(domain):
    domain = str(domain or "").strip().lower().rstrip(".")
    if not domain or len(domain) > 253:
        raise Refused("That is not a domain name.")
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+", domain):
        raise Refused("That is not a domain name.")
    return domain


# ---------------------------------------------------------------------------
# Operations — reading
# ---------------------------------------------------------------------------

def op_runtimes(ctx, req, sock):
    php = []
    for tpl in ctx["php_templates"]:
        exts = []
        binary = tpl["binary"]
        if os.path.isfile(binary):
            rc, out = sh([binary, "-m"], env=ctx["env"], timeout=20, check=False)
            if rc == 0:
                exts = sorted({
                    line.strip().lower() for line in out.splitlines()
                    if line.strip() and not line.startswith("[")
                })
        php.append({
            "version": tpl["version"],
            "template": tpl["template"],
            "extensions": exts,
        })
    # Newest first is the wrong order for a version picker — people scan for
    # the one they know — so it stays ascending and "recommended" is marked.
    if php:
        php[-1]["recommended"] = True
    nodes = ctx["node_lines"]
    default = default_node()
    for n in nodes:
        n["recommended"] = bool(default and n["major"] == default["major"])
        n["lts"] = n["major"] % 2 == 0
    send(sock, {
        "ok": True,
        "php": php,
        "node": nodes,
        "extensions": {p["version"]: p["extensions"] for p in php},
        "sites": ctx["sites_summary"],
    })


def op_nodeapps(ctx, req, sock):
    send(sock, {"ok": True, "apps": pm2_list(ctx["home"], probe=bool(req.get("probe", True)))})


def op_nodeaction(ctx, req, sock):
    name = clean_app_name(req.get("name"))
    action = str(req.get("action") or "")
    if action not in ("start", "stop", "restart", "reload", "delete"):
        raise Refused("That is not something you can do to an app.")
    pm2 = find_pm2()
    if not pm2:
        raise Refused("pm2 is not installed on this server.")
    if not pm2_app(ctx["home"], name):
        raise Refused("There is no application by that name on this account.")

    env = user_env(ctx["home"])
    sh([pm2, action, name], cwd=ctx["home"], env=env, timeout=90)
    # Without a save, a stop or a delete comes back at the next boot and the
    # customer's change quietly undoes itself.
    sh([pm2, "save", "--force"], cwd=ctx["home"], env=env, timeout=60, check=False)
    send(sock, {"ok": True})


def op_nodelogs(ctx, req, sock):
    """
    The tail of an app's two log files.

    pm2 writes `out-0.log` and `error-0.log` next to the app whatever the
    ecosystem file calls them. Reading the name in the config instead shows an
    empty log for a crash-looping app, which has cost this project an afternoon.
    The paths come from pm2 itself where it reports them, and fall back to the
    conventional pair.
    """
    name = clean_app_name(req.get("name"))
    lines = max(20, min(1000, int(req.get("lines") or 200)))
    app = pm2_app(ctx["home"], name)
    if not app:
        raise Refused("There is no application by that name on this account.")
    cwd = app.get("cwd") or os.path.join(ctx["home"], "web", name, "private", "nodeapp")

    def tail(path):
        try:
            with open(path, "rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - 256 * 1024))
                data = fh.read()
        except OSError:
            return []
        text = data.decode("utf-8", "replace").splitlines()
        return text[-lines:]

    logs = os.path.join(cwd, "logs")
    send(sock, {
        "ok": True,
        "out": tail(os.path.join(logs, "out-0.log")) or tail(os.path.join(logs, "out.log")),
        "err": tail(os.path.join(logs, "error-0.log")) or tail(os.path.join(logs, "error.log")),
    })


def app_dir(ctx, name):
    app = pm2_app(ctx["home"], name)
    cwd = (app or {}).get("cwd") or os.path.join(ctx["home"], "web", name, "private", "nodeapp")
    real = os.path.realpath(cwd)
    if not real.startswith(os.path.realpath(ctx["home"]) + os.sep):
        raise Refused("That application is not on this account.")
    return real


def op_readenv(ctx, req, sock):
    path = os.path.join(app_dir(ctx, clean_app_name(req.get("name"))), ".env")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read(64 * 1024)
    except FileNotFoundError:
        text = ""
    except OSError:
        raise Refused("That environment file could not be read.")
    send(sock, {"ok": True, "text": text})


def op_writeenv(ctx, req, sock):
    name = clean_app_name(req.get("name"))
    text = str(req.get("text") or "")
    if len(text) > 64 * 1024:
        raise Refused("That environment file is too large.")
    path = os.path.join(app_dir(ctx, name), ".env")
    # Written beside the target and renamed, so a full disk or a killed process
    # cannot leave the app with half an environment and no way to boot.
    tmp = path + ".new"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text if text.endswith("\n") else text + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    send(sock, {"ok": True})


# ---------------------------------------------------------------------------
# Operations — PHP settings
# ---------------------------------------------------------------------------

PHP_KEYS = {
    "memory_limit": "M",
    "upload_max_filesize": "M",
    "post_max_size": "M",
    "max_execution_time": "",
    "max_input_vars": "",
}

USER_INI_HEAD = (
    "; Written by the Vesopa Cloud panel. Edit it here or in the panel — the\n"
    "; panel rewrites the whole file, so anything else you add below is kept\n"
    "; only until the next save from the panel.\n"
)


def site_docroot(ctx, domain):
    fields = ctx["sites"].get(domain)
    if fields is None:
        raise Refused("That website is not on this account.")
    custom = fields.get("CUSTOM_DOCROOT") or ""
    if custom:
        real = os.path.realpath(custom)
    else:
        real = os.path.realpath(os.path.join(ctx["home"], "web", domain, "public_html"))
    if not real.startswith(os.path.realpath(ctx["home"]) + os.sep):
        raise Refused("That website is not on this account.")
    return real


def op_phpconfig(ctx, req, sock):
    domain = clean_domain(req.get("domain"))
    path = os.path.join(site_docroot(ctx, domain), ".user.ini")
    values = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "=" not in line or line.lstrip().startswith(";"):
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                if k in PHP_KEYS:
                    n = re.sub(r"[^0-9]", "", v)
                    if n:
                        values[k] = int(n)
    except OSError:
        pass
    send(sock, {"ok": True, "values": values, "path": path})


def op_setphpconfig(ctx, req, sock):
    domain = clean_domain(req.get("domain"))
    values = req.get("values") or {}
    root = site_docroot(ctx, domain)
    lines = [USER_INI_HEAD]
    for key, unit in PHP_KEYS.items():
        if key in values:
            try:
                n = int(values[key])
            except (TypeError, ValueError):
                continue
            lines.append(f"{key} = {n}{unit}\n")
    path = os.path.join(root, ".user.ini")
    tmp = path + ".new"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("".join(lines))
    os.replace(tmp, path)
    # PHP caches .user.ini for user_ini.cache_ttl seconds — 300 by default — so
    # a customer who saves and immediately re-tests sees the OLD value and
    # concludes the panel did nothing. Saying so is better than pretending.
    send(sock, {"ok": True, "path": path, "delay": 300})


# ---------------------------------------------------------------------------
# Operations — packages and plugins
# ---------------------------------------------------------------------------

def op_plugins(ctx, req, sock):
    target = str(req.get("target") or "")
    if target == "node":
        directory = app_dir(ctx, clean_app_name(req.get("name")))
        pkg_path = os.path.join(directory, "package.json")
        try:
            with open(pkg_path, "r", encoding="utf-8") as fh:
                pkg = json.load(fh)
        except (OSError, ValueError):
            raise Refused("That application has no package.json.")
        wanted = dict(pkg.get("dependencies") or {})
        items = []
        for name, spec in sorted(wanted.items()):
            installed = None
            try:
                with open(os.path.join(directory, "node_modules", name, "package.json"), "r",
                          encoding="utf-8") as fh:
                    installed = json.load(fh).get("version")
            except (OSError, ValueError):
                pass
            items.append({"name": name, "version": installed, "wanted": spec,
                          "missing": installed is None})
        send(sock, {"ok": True, "items": items})
        return

    if target == "wordpress":
        domain = clean_domain(req.get("name"))
        root = site_docroot(ctx, domain)
        plugins_dir = os.path.join(root, "wp-content", "plugins")
        if not os.path.isdir(plugins_dir):
            raise Refused("That site does not look like a WordPress install.")
        items = []
        for name in sorted(os.listdir(plugins_dir)):
            full = os.path.join(plugins_dir, name)
            if not os.path.isdir(full):
                continue
            version, title = wp_plugin_header(full)
            items.append({"name": name, "title": title, "version": version, "wanted": None})
        send(sock, {"ok": True, "items": items})
        return

    raise Refused("That is not something with packages.")


def wp_plugin_header(directory):
    """Version and display name out of a plugin's main file header."""
    try:
        names = [n for n in os.listdir(directory) if n.endswith(".php")][:12]
    except OSError:
        return None, None
    for name in names:
        try:
            with open(os.path.join(directory, name), "r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(4096)
        except OSError:
            continue
        if "Plugin Name:" not in head:
            continue
        title = re.search(r"Plugin Name:\s*(.+)", head)
        version = re.search(r"Version:\s*([0-9][^\s*]*)", head)
        return (version.group(1) if version else None,
                title.group(1).strip() if title else None)
    return None, None


def op_plugin(ctx, req, sock):
    target = str(req.get("target") or "")
    action = str(req.get("action") or "")
    pkg = str(req.get("pkg") or "")
    if action not in ("add", "remove"):
        raise Refused("That is not something you can do.")
    # Checked here as well as in the web tier. Neither trusts the other, and
    # this is the string that becomes an argv element.
    if not re.fullmatch(r"[@a-z0-9][a-z0-9._@/-]{0,110}", pkg, re.I):
        raise Refused("That is not a valid package name.")
    if pkg.startswith("-"):
        raise Refused("That is not a valid package name.")

    if target == "node":
        name = clean_app_name(req.get("name"))
        directory = app_dir(ctx, name)
        node = node_for_app(ctx, name)
        env = user_env(ctx["home"], node)
        npm = os.path.join(node["bin"], "npm") if node else "npm"
        verb = "install" if action == "add" else "uninstall"
        sh([npm, verb, "--save", "--no-audit", "--no-fund", pkg], cwd=directory, env=env)
        send(sock, {"ok": True, "restart": True})
        return

    if target == "wordpress":
        domain = clean_domain(req.get("name"))
        root = site_docroot(ctx, domain)
        wp = ensure_wp_cli(ctx)
        php = php_binary_for(ctx, domain)
        verb = ["plugin", "install", pkg, "--activate"] if action == "add" else ["plugin", "delete", pkg]
        sh([php, wp, f"--path={root}", "--skip-plugins", "--skip-themes", *verb],
           cwd=root, env=ctx["env"], timeout=300)
        send(sock, {"ok": True})
        return

    raise Refused("That is not something with packages.")


def php_binary_for(ctx, domain):
    """
    The interpreter this site is served by — wp-cli and composer must match it.

    Running composer on 8.3 for a site served by 7.4 installs a dependency tree
    the site then cannot load, and the error names a class rather than a PHP
    version. So the same two sources as sites_summary, in the same order.
    """
    for site in ctx.get("sites_summary") or []:
        if site["domain"] == domain and site.get("php"):
            candidate = f"/usr/bin/php{site['php']}"
            if os.path.isfile(candidate):
                return candidate
    return shutil.which("php") or "/usr/bin/php"


def node_for_app(ctx, name):
    app = pm2_app(ctx["home"], name)
    version = (app or {}).get("node") or ""
    major = version.split(".")[0]
    for line in ctx["node_lines"]:
        if str(line["major"]) == major:
            return line
    return default_node()


def ensure_wp_cli(ctx):
    """
    wp-cli, in the customer's own home, fetched once.

    Not installed system-wide by this file: a root download from the internet
    into /usr/local/bin on a shared box is a bigger decision than a plugin
    button should be making. A copy per account costs 7MB and is the customer's
    own quota.
    """
    target = os.path.join(ctx["home"], STATE_DIR, "wp-cli.phar")
    if os.path.isfile(target) and os.path.getsize(target) > 1_000_000:
        return target
    os.makedirs(os.path.dirname(target), exist_ok=True)
    url = "https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar"
    try:
        with urllib.request.urlopen(url, timeout=120) as res, open(target + ".part", "wb") as fh:
            shutil.copyfileobj(res, fh, CHUNK)
    except Exception:
        raise Refused("Could not fetch the WordPress command line tool. Try again shortly.")
    os.replace(target + ".part", target)
    return target


# ---------------------------------------------------------------------------
# Installing — the job runner
# ---------------------------------------------------------------------------

def jobs_dir(home):
    path = os.path.join(home, STATE_DIR, "installs")
    os.makedirs(path, exist_ok=True)
    return path


def job_path(home, job_id):
    if not re.fullmatch(r"[a-z0-9]{6,32}", str(job_id or "")):
        raise Refused("That is not an install we know about.")
    return os.path.join(jobs_dir(home), f"{job_id}.json")


class Progress:
    """
    One install's state, on disk, written after every step.

    On disk rather than in memory because the process that runs the install is
    not the process that answers the next poll — the install is a detached
    child and every poll is a new connection. A file in the customer's home is
    also what makes the progress survive a restart of this daemon, which is
    what happens in the middle of a long install on a deploy day.
    """

    def __init__(self, home, job_id, meta):
        self.path = os.path.join(jobs_dir(home), f"{job_id}.json")
        self.state = dict(meta, id=job_id, state="running", percent=0, step="Starting",
                          log=[], started=int(time.time()), error=None)
        self.flush()

    def flush(self):
        tmp = self.path + ".part"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.state, fh)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def step(self, label, percent):
        self.state["step"] = label
        self.state["percent"] = percent
        self.say(f"── {label}")

    def say(self, line):
        for part in str(line).splitlines():
            self.state["log"].append(part[:400])
        # A runaway npm install can produce tens of thousands of lines and the
        # customer is going to read the last thirty of them.
        self.state["log"] = self.state["log"][-400:]
        self.flush()

    def done(self, extra=None):
        self.state.update(state="done", percent=100, step="Finished",
                          finished=int(time.time()), **(extra or {}))
        self.flush()

    def failed(self, message):
        self.state.update(state="failed", error=str(message)[:2000],
                          step="Stopped", finished=int(time.time()))
        self.say(str(message))
        self.flush()


#: What a Hestia backup archive is called. Anchored, and it must begin with
#: this account's own name — every backup on the box lives in one flat
#: directory, so the filename is the only thing separating one customer's
#: archive from another's.
BACKUP_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}\.tar(\.(gz|zst|bz2|xz))?$")
BACKUP_DIR = "/backup"


def op_backupfile(ctx, req, sock):
    """
    Stream one of this account's backups to the browser.

    THE PERMISSION CHECK IS THE FILESYSTEM'S, not this function's. /backup is a
    flat directory holding every customer's archives, each one mode 0640 owned
    `hestiaweb:<that customer>`. This process has already dropped to the
    customer asking, so the open() below succeeds for their own archive and
    fails with EACCES for anybody else's — which is a guarantee no amount of
    string comparison on filenames can give you.

    The name check is still here, and it is doing a different job: it stops a
    path with a slash or a `..` in it from being interpreted at all, and it
    refuses a name that is not this account's before touching the disk, so the
    common mistake produces a clear refusal rather than a permission error.
    """
    name = str(req.get("name") or "")
    if not BACKUP_RE.fullmatch(name):
        raise Refused("That is not a backup file name.")
    if not name.startswith(ctx["user"] + "."):
        raise Refused("That backup does not belong to this account.")

    path = os.path.join(BACKUP_DIR, name)
    if os.path.realpath(path) != path or not os.path.isfile(path):
        raise Refused("That backup is no longer on the server.")

    try:
        fh = open(path, "rb")
    except PermissionError:
        raise Refused("That backup does not belong to this account.")

    with fh:
        size = os.fstat(fh.fileno()).st_size
        send(sock, {"ok": True, "name": name, "size": size, "body": size})
        # sendfile where the kernel will do it, and a plain copy where it will
        # not. A backup is measured in gigabytes; reading one into this
        # process to write it out again would be a gigabyte of resident memory
        # per download.
        try:
            sock.sendfile(fh)
        except (AttributeError, OSError):
            fh.seek(0)
            while True:
                chunk = fh.read(CHUNK)
                if not chunk:
                    break
                sock.sendall(chunk)


def op_job(ctx, req, sock):
    path = job_path(ctx["home"], req.get("id"))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        raise Refused("That install is not on this account.")
    send(sock, {"ok": True, **state})


def op_jobs(ctx, req, sock):
    out = []
    try:
        names = os.listdir(jobs_dir(ctx["home"]))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(jobs_dir(ctx["home"]), name), "r", encoding="utf-8") as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            continue
        state.pop("log", None)
        out.append(state)
    out.sort(key=lambda s: s.get("started", 0), reverse=True)
    send(sock, {"ok": True, "jobs": out[:40]})


# ---------------------------------------------------------------------------
# Installing — where each application comes from
# ---------------------------------------------------------------------------

#: Upstream downloads. Keep every URL a "latest" one where the project
#: publishes one, and resolve the rest through the GitHub releases API, so that
#: this table does not need editing every time somebody cuts a release. A
#: pinned version here becomes a stale install a year from now that nobody
#: notices until a customer asks why their new site is out of date.
SOURCES = {
    "wordpress": {"url": "https://wordpress.org/latest.tar.gz", "strip": 1},
    "drupal": {"url": "https://www.drupal.org/download-latest/tar.gz", "strip": 1},
    "nextcloud": {"url": "https://download.nextcloud.com/server/releases/latest.tar.bz2", "strip": 1},
    "joomla": {"github": "joomla/joomla-cms",
               "asset": r"Joomla_.*-Stable-Full_Package\.tar\.gz$", "strip": 0},
    "prestashop": {"github": "PrestaShop/PrestaShop",
                   "asset": r"prestashop_.*\.zip$", "strip": 0},
    # Moodle publishes by branch rather than a "latest" alias, so this one
    # number is the file's only pin. When it goes stale the install fails
    # loudly with the URL in the log rather than quietly fetching nothing.
    "moodle": {"url": "https://packaging.moodle.org/stable500/moodle-latest-500.tgz", "strip": 1},
    "uptime-kuma": {"git": "https://github.com/louislam/uptime-kuma.git"},
    "umami": {"git": "https://github.com/umami-software/umami.git"},
}


def github_asset(repo, pattern):
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "vesopa-cloud-installer",
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            data = json.load(res)
    except Exception as exc:
        raise Refused(f"Could not ask GitHub for the latest {repo} release: {exc}")
    for asset in data.get("assets") or []:
        if re.search(pattern, asset.get("name") or ""):
            return asset["browser_download_url"], data.get("tag_name") or ""
    raise Refused(f"The latest {repo} release has no file matching what we expect.")


def download(url, target, progress):
    progress.say(f"Fetching {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vesopa-cloud-installer"})
        with urllib.request.urlopen(req, timeout=120) as res, open(target, "wb") as fh:
            total = 0
            while True:
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                total += len(chunk)
                if total > 4 * 1024 * 1024 * 1024:
                    raise Refused("That download is implausibly large and was stopped.")
    except Refused:
        raise
    except Exception as exc:
        raise Refused(f"The download failed: {exc}")
    progress.say(f"Fetched {round(os.path.getsize(target) / 1048576, 1)} MB")


def unpack(archive, into, strip, progress):
    """
    Unpack with the system tools rather than tarfile/zipfile.

    `tar --strip-components` and `unzip` are far faster than the Python modules
    on a 200 MB archive, and both refuse absolute and `..` members by default on
    a modern Linux. The archive is upstream's own release, but it is still an
    archive off the internet being written into somebody's home directory, so
    the extraction is done by the thing that has been hardened against exactly
    that for thirty years.
    """
    os.makedirs(into, exist_ok=True)
    progress.say("Unpacking")
    if archive.endswith(".zip"):
        sh(["unzip", "-q", "-o", archive, "-d", into], timeout=STEP_TIMEOUT)
        if strip:
            collapse(into)
    else:
        argv = ["tar", "-xf", archive, "-C", into]
        if strip:
            argv += [f"--strip-components={strip}"]
        sh(argv, timeout=STEP_TIMEOUT)


def collapse(directory):
    """A zip that unpacks into a single folder — hoist its contents up one."""
    entries = [e for e in os.listdir(directory) if not e.startswith(".")]
    if len(entries) != 1:
        return
    inner = os.path.join(directory, entries[0])
    if not os.path.isdir(inner):
        return
    for name in os.listdir(inner):
        shutil.move(os.path.join(inner, name), os.path.join(directory, name))
    os.rmdir(inner)


# ---------------------------------------------------------------------------
# Installing — the recipes
# ---------------------------------------------------------------------------

def wp_salts():
    """
    Fresh WordPress salts, generated here rather than fetched.

    api.wordpress.org/secret-key/1.1/salt/ is the usual source and it is a
    needless dependency: the keys are sixty-four random printable characters
    each and os.urandom is a better source than an HTTP request that can fail
    halfway through an install. A WordPress with the default "put your unique
    phrase here" salts has every session cookie forgeable, so this is not a
    cosmetic step.
    """
    alphabet = ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                "0123456789!@#$%^&*()-_ []{}<>~`+=,.;:/?|")
    keys = ["AUTH_KEY", "SECURE_AUTH_KEY", "LOGGED_IN_KEY", "NONCE_KEY",
            "AUTH_SALT", "SECURE_AUTH_SALT", "LOGGED_IN_SALT", "NONCE_SALT"]
    out = []
    for key in keys:
        value = "".join(alphabet[b % len(alphabet)] for b in os.urandom(64))
        value = value.replace("'", "-").replace("\\", "-")
        out.append(f"define('{key}', '{value}');")
    return "\n".join(out)


def write_wp_config(build, ctx, job):
    sample = os.path.join(build, "wp-config-sample.php")
    try:
        with open(sample, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        raise Refused("That WordPress download did not contain a config template.")
    text = text.replace("database_name_here", job["database"] or "")
    text = text.replace("username_here", job["db_user"] or "")
    text = text.replace("password_here", job["db_password"] or "")
    text = re.sub(
        r"define\(\s*'AUTH_KEY'.*?'NONCE_SALT',[^)]*\);",
        wp_salts(), text, flags=re.S,
    )
    # A prefix that is not wp_ turns the whole class of "scan for wp_users"
    # attacks into a miss. Random rather than chosen, because a customer asked
    # to pick one picks `wp2_`.
    prefix = "wp" + "".join("abcdefghijkmnpqrstuvwxyz23456789"[b % 32] for b in os.urandom(4)) + "_"
    text = re.sub(r"\$table_prefix\s*=\s*'wp_';", f"$table_prefix = '{prefix}';", text)
    with open(os.path.join(build, "wp-config.php"), "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(os.path.join(build, "wp-config.php"), 0o640)
    return prefix


def recipe_php_tarball(ctx, job, progress, build):
    """Every PHP application that ships a tarball: fetch, unpack, configure."""
    slug = job["slug"]
    source = SOURCES[slug]
    url = source.get("url")
    if not url and source.get("github"):
        progress.step("Finding the latest release", 10)
        url, tag = github_asset(source["github"], source["asset"])
        progress.say(f"Latest is {tag}")

    progress.step("Downloading", 20)
    suffix = ".zip" if url.endswith(".zip") else ".tar"
    archive = os.path.join(build, "..", f"{job['id']}{suffix}")
    download(url, archive, progress)

    progress.step("Unpacking", 45)
    unpack(archive, build, source.get("strip", 0), progress)
    os.unlink(archive)

    if slug == "wordpress":
        progress.step("Writing the configuration", 70)
        prefix = write_wp_config(build, ctx, job)
        progress.say(f"Table prefix {prefix}")

    progress.step("Setting permissions", 80)
    harden(build)


def harden(root):
    """
    Sane permissions on a freshly unpacked application.

    Directories 755 and files 644, and nothing group- or world-writable. Upstream
    archives are inconsistent about this — some ship 777 on a cache directory —
    and PHP-FPM runs as the account's own user here, so it does not need group
    write for anything.
    """
    for base, dirs, files in os.walk(root):
        # Skip the dependency tree. It is tens of thousands of files that npm
        # has already written with sane modes, and walking it adds a minute to
        # a Ghost install for no benefit.
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "vendor")]
        for name in dirs:
            try:
                os.chmod(os.path.join(base, name), 0o755)
            except OSError:
                pass
        for name in files:
            try:
                path = os.path.join(base, name)
                mode = 0o640 if name in (".env", "wp-config.php", "configuration.php") else 0o644
                os.chmod(path, mode)
            except OSError:
                pass


STARTER_SERVER = """\
// A Node application, as small as one can be and still be real.
//
// It listens on the port the panel gave it, which arrives in the environment.
// DO NOT hard-code a port here: the panel checks THAT port to decide whether
// your app is working, and an app listening somewhere else shows as
// "running, not answering" no matter how healthy it is.
const http = require('node:http');

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8">
<title>It works</title>
<style>body{font:16px/1.6 system-ui;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#111}
code{background:#f1f3ea;padding:.15em .4em;border-radius:4px}</style>
<h1>Your Node app is running.</h1>
<p>This is <code>server.js</code>. Replace it with your own code — the file
manager and the terminal are both in the panel — then restart the app.</p>
<p>Node ${process.version}, listening on port ${port}.</p>`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`listening on 127.0.0.1:${port}`);
});
"""


def recipe_node(ctx, job, progress, build):
    """
    A Node application: create it through the node wrapper, then fill it in.

    ORDER MATTERS AND IT IS COUNTER-INTUITIVE. `v-add-nodejs-app` regenerates
    `.env` every time it runs, so it has to go FIRST and the application files
    second. Doing it the other way round — the obvious way — wipes the app's
    environment on the last step of its own install.
    """
    slug = job["slug"]
    domain = job["domain"]
    node = pick_node(ctx, job.get("node"))
    env = user_env(ctx["home"], node)

    progress.step("Preparing the application", 10)
    target = ctx.get("node_target") or os.path.join(ctx["home"], "web", domain, "private", "nodeapp")
    if not os.path.isdir(target):
        raise Refused("The node application directory was not created. Support has been notified.")

    port = read_port(target)
    progress.say(f"Node {node['version']}, port {port}")

    if slug == "node-starter":
        progress.step("Writing the starter app", 45)
        write_file(build, "server.js", STARTER_SERVER)
        write_file(build, "package.json", json.dumps({
            "name": domain.replace(".", "-"),
            "version": "1.0.0",
            "private": True,
            "main": "server.js",
            "scripts": {"start": "node server.js"},
        }, indent=2) + "\n")

    elif slug == "nextjs":
        progress.step("Creating the Next.js project", 30)
        write_next_project(build, domain)
        progress.step("Installing dependencies", 50)
        npm(build, env, node, ["install", "--no-audit", "--no-fund"], progress)
        progress.step("Building", 75)
        npm(build, env, node, ["run", "build"], progress)

    elif slug == "n8n":
        progress.step("Installing n8n", 40)
        write_file(build, "package.json", json.dumps({
            "name": domain.replace(".", "-"), "version": "1.0.0", "private": True,
            "scripts": {"start": "n8n start"}, "dependencies": {"n8n": "latest"},
        }, indent=2) + "\n")
        npm(build, env, node, ["install", "--no-audit", "--no-fund"], progress)

    elif slug in ("uptime-kuma", "umami"):
        progress.step("Fetching the source", 25)
        sh(["git", "clone", "--depth", "1", SOURCES[slug]["git"], build],
           env=env, timeout=STEP_TIMEOUT)
        progress.step("Installing dependencies", 50)
        npm(build, env, node, ["install", "--no-audit", "--no-fund"], progress)
        progress.step("Building", 75)
        if slug == "umami":
            write_file(build, ".env", node_env_text(job, port, extra={
                "DATABASE_URL": mysql_url(job),
                "APP_SECRET": os.urandom(24).hex(),
            }))
            npm(build, env, node, ["run", "build"], progress)
        else:
            npm(build, env, node, ["run", "setup"], progress)

    elif slug == "ghost":
        progress.step("Finding the latest release", 20)
        url, tag = github_asset("TryGhost/Ghost", r"^[Gg]host-.*\.zip$")
        progress.say(f"Ghost {tag}")
        archive = os.path.join(build, "..", f"{job['id']}.zip")
        download(url, archive, progress)
        progress.step("Unpacking", 45)
        unpack(archive, build, 0, progress)
        os.unlink(archive)
        progress.step("Installing dependencies", 60)
        npm(build, env, node, ["install", "--omit=dev", "--no-audit", "--no-fund"], progress)
        write_file(build, "config.production.json", json.dumps({
            "url": f"https://{domain}",
            "server": {"port": port, "host": "127.0.0.1"},
            "database": {
                "client": "mysql",
                "connection": {
                    "host": "127.0.0.1", "user": job["db_user"],
                    "password": job["db_password"], "database": job["database"],
                },
            },
            "mail": {"transport": "Direct"},
            "logging": {"transports": ["file", "stdout"]},
            "process": "local",
        }, indent=2) + "\n")

    elif slug == "strapi":
        progress.step("Creating the Strapi project", 30)
        npx(build, env, node, [
            "create-strapi-app@latest", ".", "--no-run", "--skip-cloud",
            "--use-npm", "--js", "--dbclient=sqlite",
        ], progress)
        progress.step("Building the admin", 70)
        npm(build, env, node, ["run", "build"], progress)

    else:
        raise Refused("That application does not have an installer yet.")

    if slug != "umami":
        write_file(build, ".env", node_env_text(job, port))
    progress.step("Setting permissions", 88)
    harden(build)
    return target


def pick_node(ctx, wanted):
    lines = ctx["node_lines"]
    if not lines:
        raise Refused("No Node.js runtime is installed on this server.")
    if wanted:
        for line in lines:
            if str(line["major"]) == str(wanted):
                return line
    return default_node()


def read_port(target):
    for name in (".env", "ecosystem.config.js", "ecosystem.config.cjs"):
        try:
            with open(os.path.join(target, name), "r", encoding="utf-8", errors="replace") as fh:
                m = re.search(r"PORT\D{0,4}(\d{4,5})", fh.read())
                if m:
                    return int(m.group(1))
        except OSError:
            continue
    return None


def mysql_url(job):
    from urllib.parse import quote
    return (f"mysql://{quote(job['db_user'] or '')}:{quote(job['db_password'] or '')}"
            f"@127.0.0.1:3306/{job['database'] or ''}")


def node_env_text(job, port, extra=None):
    lines = [
        "# Written by the Vesopa Cloud installer.",
        "#",
        "# PORT is the one line not to change. The panel checks this port to",
        "# decide whether your app is working, and nginx sends the site's",
        "# traffic to it. An app listening anywhere else is unreachable.",
        f"PORT={port or 3000}",
        "NODE_ENV=production",
    ]
    if job.get("database"):
        lines += [
            "",
            "DB_HOST=127.0.0.1",
            f"DB_NAME={job['database']}",
            f"DB_USER={job['db_user']}",
            f"DB_PASSWORD={job['db_password']}",
            f"DATABASE_URL={mysql_url(job)}",
        ]
    for key, value in (extra or {}).items():
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def write_file(directory, name, text):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, 0o640 if name == ".env" else 0o644)


def npm(cwd, env, node, args, progress):
    binary = os.path.join(node["bin"], "npm") if node else "npm"
    rc, out = sh([binary, *args], cwd=cwd, env=env, check=False)
    progress.say("\n".join(out.strip().splitlines()[-25:]))
    if rc != 0:
        raise Refused(f"`npm {args[0]}` failed. The last lines of its output are above.")


def npx(cwd, env, node, args, progress):
    binary = os.path.join(node["bin"], "npx") if node else "npx"
    rc, out = sh([binary, "--yes", *args], cwd=cwd, env=env, check=False)
    progress.say("\n".join(out.strip().splitlines()[-25:]))
    if rc != 0:
        raise Refused("Creating the project failed. The last lines of its output are above.")


NEXT_PAGE = """\
export default function Home() {
  return (
    <main style={{ font: '16px/1.6 system-ui', margin: '12vh auto', maxWidth: '34rem', padding: '0 1.5rem' }}>
      <h1>Your Next.js app is running.</h1>
      <p>Edit <code>app/page.js</code>, then rebuild and restart from the panel.</p>
    </main>
  );
}
"""

NEXT_LAYOUT = """\
export const metadata = { title: 'It works' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, color: '#111' }}>{children}</body>
    </html>
  );
}
"""


def write_next_project(build, domain):
    write_file(build, "package.json", json.dumps({
        "name": domain.replace(".", "-"),
        "version": "1.0.0",
        "private": True,
        "scripts": {
            "dev": "next dev",
            "build": "next build",
            # -H 127.0.0.1 is not optional on this box: an app that binds
            # 0.0.0.0 is reachable from outside nginx on its raw port.
            "start": "next start -H 127.0.0.1 -p ${PORT:-3000}",
        },
        "dependencies": {"next": "latest", "react": "latest", "react-dom": "latest"},
    }, indent=2) + "\n")
    os.makedirs(os.path.join(build, "app"), exist_ok=True)
    write_file(os.path.join(build, "app"), "page.js", NEXT_PAGE)
    write_file(os.path.join(build, "app"), "layout.js", NEXT_LAYOUT)
    write_file(build, "next.config.js", "module.exports = { output: 'standalone' };\n")


STATIC_INDEX = """\
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(domain)s</title>
<style>
  body { font: 16px/1.65 system-ui, sans-serif; color: #111; margin: 14vh auto;
         max-width: 36rem; padding: 0 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .6rem; }
  p { color: #4a4c41; }
  code { background: #f1f3ea; padding: .15em .4em; border-radius: 4px; }
</style>
<h1>%(domain)s is live.</h1>
<p>This page is <code>index.html</code> in your web root. Replace it with your
own site — upload the files in the panel's file manager, or push them over SFTP.</p>
"""


def recipe_static(ctx, job, progress, build):
    progress.step("Writing the holding page", 50)
    write_file(build, "index.html", STATIC_INDEX % {"domain": job["domain"]})


RECIPES = {
    "wordpress": recipe_php_tarball,
    "drupal": recipe_php_tarball,
    "joomla": recipe_php_tarball,
    "prestashop": recipe_php_tarball,
    "moodle": recipe_php_tarball,
    "nextcloud": recipe_php_tarball,
    "laravel": None,          # composer, wired below
    "node-starter": recipe_node,
    "nextjs": recipe_node,
    "ghost": recipe_node,
    "strapi": recipe_node,
    "n8n": recipe_node,
    "umami": recipe_node,
    "uptime-kuma": recipe_node,
    "static": recipe_static,
}


def ensure_composer(ctx, progress):
    """Composer, in the customer's home, fetched once. Same argument as wp-cli."""
    target = os.path.join(ctx["home"], STATE_DIR, "composer.phar")
    if os.path.isfile(target) and os.path.getsize(target) > 500_000:
        return target
    os.makedirs(os.path.dirname(target), exist_ok=True)
    progress.say("Fetching composer")
    download("https://getcomposer.org/composer-stable.phar", target + ".part", progress)
    os.replace(target + ".part", target)
    os.chmod(target, 0o755)
    return target


def recipe_laravel(ctx, job, progress, build):
    php = php_binary_for(ctx, job["domain"])
    progress.step("Fetching composer", 15)
    composer = ensure_composer(ctx, progress)
    progress.step("Creating the project", 30)
    rc, out = sh([php, composer, "create-project", "laravel/laravel", build,
                  "--no-interaction", "--prefer-dist"],
                 cwd=ctx["home"], env=ctx["env"], check=False)
    progress.say("\n".join(out.strip().splitlines()[-25:]))
    if rc != 0:
        raise Refused("Composer could not create the project. Its output is above.")

    progress.step("Writing the configuration", 70)
    env_path = os.path.join(build, ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        text = ""
    text = re.sub(r"^DB_DATABASE=.*$", f"DB_DATABASE={job['database']}", text, flags=re.M)
    text = re.sub(r"^DB_USERNAME=.*$", f"DB_USERNAME={job['db_user']}", text, flags=re.M)
    text = re.sub(r"^DB_PASSWORD=.*$", f"DB_PASSWORD={job['db_password']}", text, flags=re.M)
    text = re.sub(r"^DB_CONNECTION=.*$", "DB_CONNECTION=mysql", text, flags=re.M)
    text = re.sub(r"^APP_URL=.*$", f"APP_URL=https://{job['domain']}", text, flags=re.M)
    text = re.sub(r"^APP_ENV=.*$", "APP_ENV=production", text, flags=re.M)
    text = re.sub(r"^APP_DEBUG=.*$", "APP_DEBUG=false", text, flags=re.M)
    write_file(build, ".env", text)
    sh([php, "artisan", "key:generate", "--force"], cwd=build, env=ctx["env"], check=False)
    progress.step("Setting permissions", 85)
    harden(build)
    # Laravel writes here at runtime and only here.
    for writable in ("storage", os.path.join("bootstrap", "cache")):
        path = os.path.join(build, writable)
        for base, dirs, _files in os.walk(path):
            for name in dirs:
                try:
                    os.chmod(os.path.join(base, name), 0o775)
                except OSError:
                    pass
        try:
            os.chmod(path, 0o775)
        except OSError:
            pass


RECIPES["laravel"] = recipe_laravel


# ---------------------------------------------------------------------------
# Installing — putting it where the web server looks
# ---------------------------------------------------------------------------

def replaced_dir(home):
    path = os.path.join(home, STATE_DIR, "replaced")
    os.makedirs(path, exist_ok=True)
    return path


def swap_into_place(home, build, target, progress, merge=False):
    """
    Move a finished build into the live location, without ever deleting.

    NOTHING IS REMOVED, EVER. Whatever was in the web root goes to
    ~/.vesopa/replaced/<name>-<timestamp> and stays there. A customer who
    installs WordPress over the site they spent a weekend on has made a mistake
    that takes one `mv` to undo, and an installer that instead made it
    unrecoverable would be the worst bug in this application.

    `merge` is for a Node app, where the wrapper has already created the
    directory with an nginx-visible ecosystem file and a logs folder. There the
    build is laid ON TOP rather than swapped in, so those survive.
    """
    os.makedirs(os.path.dirname(target), exist_ok=True)

    if merge:
        progress.say("Copying the application into place")
        for name in os.listdir(build):
            src = os.path.join(build, name)
            dst = os.path.join(target, name)
            if os.path.exists(dst):
                stamp = time.strftime("%Y%m%d-%H%M%S")
                shutil.move(dst, os.path.join(replaced_dir(home), f"{name}-{stamp}"))
            shutil.move(src, dst)
        shutil.rmtree(build, ignore_errors=True)
        return

    if os.path.exists(target):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        keep = os.path.join(replaced_dir(home), f"{os.path.basename(target)}-{stamp}")
        progress.say(f"Moving what was there to {keep.replace(home, '~')}")
        shutil.move(target, keep)
    shutil.move(build, target)


def clean_docroot(docroot):
    """
    A framework's public directory name, and nothing else.

    This is the one value from the web tier that ends up as half of a path the
    web root will point at. `public` is what it is for; `../../..` is what it
    must never be. The catalogue only ever sends a single lowercase word, so the
    alphabet here is deliberately narrower than a path — anything with a slash
    or a dot in it is refused rather than normalised, because a normaliser is a
    thing to get subtly wrong and a rejection is not.
    """
    if not docroot:
        return None
    docroot = str(docroot)
    if not re.fullmatch(r"[a-z0-9_-]{1,32}", docroot):
        raise Refused("That application asked for a document root we will not set.")
    return docroot


def clean_identifier(value, what):
    """A database name, user or password, on its way into a config file."""
    if value is None:
        return None
    value = str(value)
    if len(value) > 128:
        raise Refused(f"That {what} is too long.")
    if any(c in value for c in "\n\r\x00'\"\\`$"):
        raise Refused(f"That {what} contains characters we will not write to a config file.")
    return value


def link_docroot(home, domain, app_root, docroot, progress):
    """
    Point the web root at a framework's public directory.

    Laravel, Symfony and friends keep the application ABOVE the web root on
    purpose: `.env` and the vendor tree must not be fetchable as plain text.
    Hestia serves `public_html`, so `public_html` becomes a symlink into the
    application's own public directory and the rest of the framework sits
    outside anything nginx will serve.

    A symlink rather than asking Hestia to change the document root, because the
    symlink needs no root, no template rebuild and no nginx reload — and it is
    visible in the file manager, so the next person to look can see what was
    done and undo it.
    """
    public_html = os.path.join(home, "web", domain, "public_html")
    real_target = os.path.join(app_root, docroot)
    if not os.path.isdir(real_target):
        raise Refused("The application did not produce the public directory it should have.")
    if os.path.islink(public_html):
        os.unlink(public_html)
    elif os.path.exists(public_html):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        shutil.move(public_html, os.path.join(replaced_dir(home), f"public_html-{domain}-{stamp}"))
    os.symlink(os.path.relpath(real_target, os.path.dirname(public_html)), public_html)
    progress.say(f"public_html now points at {docroot}/")


def run_job(ctx, job, progress):
    slug = job["slug"]
    recipe = RECIPES.get(slug)
    if recipe is None:
        raise Refused("That application does not have an installer yet.")

    build = os.path.join(ctx["home"], STATE_DIR, "build", job["id"])
    shutil.rmtree(build, ignore_errors=True)
    os.makedirs(build, exist_ok=True)

    kind = job["kind"]
    recipe(ctx, job, progress, build)

    progress.step("Putting it in place", 92)
    if kind == "node":
        target = ctx["node_target"]
        swap_into_place(ctx["home"], build, target, progress, merge=True)
        pm2 = find_pm2()
        if pm2:
            progress.step("Starting the app", 96)
            sh([pm2, "restart", job["domain"], "--update-env"],
               cwd=target, env=user_env(ctx["home"]), timeout=120, check=False)
            sh([pm2, "save", "--force"], cwd=target, env=user_env(ctx["home"]),
               timeout=60, check=False)
        job["url"] = f"https://{job['domain']}"
    elif job.get("docroot"):
        app_root = os.path.join(ctx["home"], "web", job["domain"], "private", slug)
        swap_into_place(ctx["home"], build, app_root, progress)
        link_docroot(ctx["home"], job["domain"], app_root, job["docroot"], progress)
        job["url"] = f"https://{job['domain']}"
    else:
        target = os.path.join(ctx["home"], "web", job["domain"], "public_html")
        swap_into_place(ctx["home"], build, target, progress)
        job["url"] = f"https://{job['domain']}"

    progress.done({"url": job.get("url"), "next": next_step_for(slug)})


def next_step_for(slug):
    """The one sentence somebody needs after the progress bar fills."""
    return {
        "wordpress": "Open your site and finish the five-minute WordPress setup — it will ask for a site title and an admin account.",
        "drupal": "Open your site and follow Drupal's installer. It will ask for the database details, which are on this page.",
        "joomla": "Open your site and follow Joomla's installer, using the database details on this page.",
        "prestashop": "Open your site to run the PrestaShop installer, then delete the install folder when it tells you to.",
        "moodle": "Open your site to run Moodle's installer. It is a long one — leave the tab open.",
        "nextcloud": "Open your site and create the admin account. The database details are on this page.",
        "laravel": "Your application is live. Deploy your own code over it with git or the file manager.",
        "node-starter": "Your app is running. Replace server.js with your own code, then restart it from the Node apps page.",
        "nextjs": "Your app is running. Note that changing the code needs a rebuild — `npm run build` in the terminal — before a restart shows it.",
        "ghost": "Open your site and create the first account. Ghost sends email through this server, so check the Email page if invites do not arrive.",
        "strapi": "Open /admin on your site to create the first Strapi administrator.",
        "n8n": "Open your site and create the owner account. n8n is not licensed for reselling automation as a service — check its licence if that is the plan.",
        "umami": "Sign in at /login with admin / umami and change the password immediately.",
        "uptime-kuma": "Open your site and create the admin account.",
        "static": "Your holding page is live. Replace index.html with your own site.",
    }.get(slug, "Your application is installed.")


def start_job(ctx, job, conn=None):
    """
    Fork, detach, and run the recipe. The caller has already answered.

    Double-fork so the worker is reparented to init: this connection's process
    exits as soon as the job id has been sent, and a job must not die with it.
    """
    if os.fork() != 0:
        return
    os.setsid()
    if os.fork() != 0:
        os._exit(0)

    # Nothing from here on has a socket to talk to. Everything it has to say
    # goes in the progress file.
    for fd in (0, 1, 2):
        try:
            os.close(fd)
        except OSError:
            pass
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    # The worker inherited the client's socket. Holding it open for the length
    # of a six-minute install keeps a connection alive that both ends have
    # finished with.
    if conn is not None:
        try:
            conn.close()
        except OSError:
            pass

    progress = Progress(ctx["home"], job["id"], {
        "slug": job["slug"], "domain": job["domain"], "name": job["name"],
    })
    def too_long(_sig, _frame):
        # Without this the alarm kills the worker outright and the progress
        # file says "running" until the end of time, so the panel spins for
        # ever on an install that died half an hour ago.
        progress.failed(
            f"This install was still going after {JOB_TIMEOUT // 60} minutes and was stopped. "
            "Nothing was changed on your site — open a ticket and we will look at the log."
        )
        os._exit(1)

    signal.signal(signal.SIGALRM, too_long)
    signal.alarm(JOB_TIMEOUT)
    try:
        run_job(ctx, job, progress)
    except Refused as exc:
        progress.failed(str(exc))
    except Exception as exc:                     # never leak a traceback
        progress.failed(f"The install stopped unexpectedly: {exc}")
    finally:
        shutil.rmtree(os.path.join(ctx["home"], STATE_DIR, "build", job["id"]),
                      ignore_errors=True)
    os._exit(0)


def op_install(ctx, req, sock):
    slug = str(req.get("slug") or "")
    if slug not in RECIPES:
        raise Refused("There is no such application.")
    domain = clean_domain(req.get("domain"))
    if domain not in ctx["sites"]:
        raise Refused("That website is not on this account.")

    job_id = os.urandom(6).hex()
    job = {
        "id": job_id,
        "slug": slug,
        "name": slug,
        "domain": domain,
        "kind": ctx["kind"],
        "docroot": clean_docroot(req.get("docroot")),
        "database": clean_identifier(req.get("database"), "database name"),
        "db_user": clean_identifier(req.get("db_user"), "database user"),
        "db_password": clean_identifier(req.get("db_password"), "database password"),
        "node": req.get("node") or None,
    }

    # One install per site at a time. Two recipes writing the same web root is
    # a corrupted site, and the second one would win by accident.
    for existing in list_running_jobs(ctx["home"]):
        if existing.get("domain") == domain:
            raise Refused("There is already an install running on that site. Wait for it to finish.")

    send(sock, {"ok": True, "job": job_id})
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    start_job(ctx, job, sock)


def list_running_jobs(home):
    out = []
    try:
        names = os.listdir(jobs_dir(home))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(jobs_dir(home), name), "r", encoding="utf-8") as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            continue
        if state.get("state") == "running" and time.time() - state.get("started", 0) < JOB_TIMEOUT:
            out.append(state)
    return out


# ---------------------------------------------------------------------------
# One connection
# ---------------------------------------------------------------------------

HANDLERS = {
    "runtimes": op_runtimes,
    "nodeapps": op_nodeapps,
    "nodeaction": op_nodeaction,
    "nodelogs": op_nodelogs,
    "readenv": op_readenv,
    "writeenv": op_writeenv,
    "phpconfig": op_phpconfig,
    "setphpconfig": op_setphpconfig,
    "plugins": op_plugins,
    "plugin": op_plugin,
    "install": op_install,
    "job": op_job,
    "jobs": op_jobs,
    "backupfile": op_backupfile,
}


def root_phase_install(entry, conf, req):
    """
    The only work in this file that happens as root, and why it has to.

    `v-add-nodejs-app` writes an nginx include, creates a systemd unit and
    enables the account's pm2 daemon. None of that is the customer's to do, and
    none of it can be done after the privilege drop. It runs here — before the
    fork, before setuid, with arguments that have already been validated — and
    everything from the drop onward is unprivileged.

    A PHP install has no root phase at all: unpacking a tarball into somebody's
    own web root needs nothing but their own permissions.
    """
    slug = str(req.get("slug") or "")
    kind = "node" if RECIPES.get(slug) is recipe_node else (
        "static" if slug == "static" else "php")
    out = {"kind": kind, "node_target": None}
    if kind != "node":
        return out

    domain = clean_domain(req.get("domain"))
    major = str(req.get("node") or "")
    if major and not re.fullmatch(r"\d{1,3}", major):
        raise Refused("That is not a Node version.")

    wrapper = os.path.join(HESTIA_BIN, "v-add-nodejs-app")
    if not os.path.isfile(wrapper):
        raise Refused("This server cannot run Node applications yet. Support has been notified.")

    argv = [wrapper, entry.pw_name, domain]
    if major:
        argv.append(major)
    rc, output = sh(argv, timeout=300, check=False)
    # Exit 4 is Hestia's "already exists", which is the ordinary case when
    # somebody reinstalls over an app they already have. Anything else stops
    # the install before a single file is written.
    if rc not in (0, 4):
        tail = "\n".join(output.strip().splitlines()[-8:])
        raise Refused(f"The server could not create the Node application:\n{tail}")

    out["node_target"] = os.path.join(entry.pw_dir, "web", domain, "private", "nodeapp")
    return out


ROOT_PHASE = {"install": root_phase_install}

#: Which root-only facts each operation actually reads. See run_request.
NEEDS_SITES = {"runtimes", "phpconfig", "setphpconfig", "install", "plugins", "plugin"}
NEEDS_TEMPLATES = {"runtimes"}
NEEDS_NODE = {"runtimes", "install", "plugin"}


def run_request(conn):
    conn.settimeout(120)
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

    if op not in HANDLERS:
        fail(conn, "That operation is not supported.")
        return

    # ---- as root: read what only root can read, do what only root can do ----
    #
    # Only what THIS operation needs. `node_lines()` runs `node -v` once per
    # installed major, and the Node apps page polls `nodeapps` every ten
    # seconds — gathering all of it unconditionally meant three subprocess
    # spawns and a config file read on the hottest request in the feature, for
    # facts it never looks at.
    try:
        sites = hestia_web_domains(entry.pw_name) if op in NEEDS_SITES else {}
        pools = php_pools() if op in NEEDS_SITES else {}
        templates = php_templates() if op in NEEDS_TEMPLATES else []
        lines = node_lines() if op in NEEDS_NODE else []
        extra = ROOT_PHASE[op](entry, conf, req) if op in ROOT_PHASE else {}
    except Refused as exc:
        fail(conn, str(exc), "refused")
        return
    except Exception as exc:
        log(f"root phase failed for {entry.pw_name}/{op}: {exc}")
        fail(conn, "The server could not prepare that. Support has been notified.")
        return

    # ---- drop, act ---------------------------------------------------------
    # This process is a per-connection child and exits at the end of this
    # function, which is what makes the drop irreversible.
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
    ctx = {
        "home": home,
        "user": entry.pw_name,
        "conf": conf,
        "sites": sites,
        "sites_summary": [
            {
                "domain": name,
                "backend": fields.get("BACKEND") or "",
                # The template name first, because a site explicitly pinned to a
                # version says so there; the pool directory second, which is
                # where a site on the `default` template gives itself away.
                "php": (lambda m: f"{m.group(1)}.{m.group(2)}" if m else None)(
                    re.fullmatch(r"PHP-(\d+)_(\d+)", fields.get("BACKEND") or "")
                ) or pools.get(name),
                "ssl": (fields.get("SSL") or "no").lower() == "yes",
                "suspended": (fields.get("SUSPENDED") or "no").lower() == "yes",
            }
            for name, fields in sorted(sites.items())
        ],
        "php_templates": templates,
        "node_lines": lines,
        "env": user_env(home),
        **extra,
    }

    try:
        HANDLERS[op](ctx, req, conn)
    except Refused as exc:
        fail(conn, str(exc), "refused")
    except PermissionError:
        fail(conn, "You do not have permission to do that.", "denied")
    except FileNotFoundError:
        fail(conn, "That is no longer there.", "missing")
    except OSError as exc:
        if exc.errno in (errno.EDQUOT, errno.ENOSPC):
            fail(conn, "There is no space left on your account.", "quota")
        else:
            fail(conn, f"That did not work: {exc.strerror or exc}.")
    except Exception as exc:
        log(f"{op} failed for {entry.pw_name}: {exc}")
        fail(conn, "Something went wrong. Support has been notified.")
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

    # The socket permissions ARE the access control, exactly as in the other two
    # brokers: 0660 root:<web group>. Not 0666 — every customer on this box has
    # a shell, and 0666 would let any of them install an application into any
    # other customer's web root.
    try:
        gid = grp.getgrnam(SOCKET_GROUP).gr_gid
        os.chown(SOCKET_PATH, 0, gid)
        os.chmod(SOCKET_PATH, 0o660)
    except KeyError:
        log(f"group {SOCKET_GROUP!r} does not exist — refusing to open the socket to everyone")
        sys.exit(1)

    server.listen(32)
    log(f"listening on {SOCKET_PATH}")
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)

    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            continue
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
