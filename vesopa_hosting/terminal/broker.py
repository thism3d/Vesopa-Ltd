#!/usr/bin/env python3
"""
The privileged half of the web terminal.

WHY A SEPARATE PROCESS

The website runs as an ordinary user. Giving a customer a shell means running a
process as THEIR unix account, and nothing but root can change user — so
something privileged has to exist. The choice is where to put it, and the two
bad answers are putting it in the website (which then runs as root, so every
bug in a route becomes a root bug) and handing the website a blanket sudo rule
(same thing wearing a hat).

This is the small answer instead: one file, no dependencies, no network socket,
and one job. It listens on a unix socket the website can reach and nothing else
can, and the only thing it will do is open a shell as a named user — never root,
never an account HestiaCP does not know about, never a shell the account has not
been given. The website decides WHO is asking; this decides whether that is a
thing it is allowed to ask for.

WHY PYTHON

`pty` is in the standard library. The alternative was node-pty, a native module
that has to be compiled on the box and rebuilt against every Node upgrade — a
build dependency on a production host, to get something Python already has.

PROTOCOL

Line one is a JSON handshake:

    {"user": "u265966", "cols": 80, "rows": 24}\\n

After that, framed both ways:

    [1 byte type][4 bytes big-endian length][payload]

    type 0  data    raw bytes to and from the pty
    type 1  resize  {"cols":N,"rows":N} — client to broker only
    type 2  notice  UTF-8 text from the broker, shown to the user

Framing rather than a raw stream because resize has to travel on the same
connection, and a pty carries arbitrary bytes — there is no in-band escape that
a shell could not also emit.
"""

import fcntl
import grp
import json
import os
import pty
import pwd
import select
import signal
import socket
import struct
import sys
import termios
import time

SOCKET_PATH = os.environ.get("VESOPA_TERMINAL_SOCKET", "/run/vesopa-terminal/broker.sock")
SOCKET_GROUP = os.environ.get("VESOPA_TERMINAL_GROUP", "vesopasoftware")
HESTIA_USERS = "/usr/local/hestia/data/users"

# A session nobody has typed into for this long is closed. A browser tab that
# goes away without a clean close leaves the socket open and a shell running
# behind it, and those accumulate.
IDLE_TIMEOUT = int(os.environ.get("VESOPA_TERMINAL_IDLE", "900"))

# And a hard ceiling regardless of activity, because `top` is activity.
MAX_SESSION = int(os.environ.get("VESOPA_TERMINAL_MAX", "14400"))

MAX_FRAME = 1 << 20

TYPE_DATA = 0
TYPE_RESIZE = 1
TYPE_NOTICE = 2


def log(msg):
    print(f"[terminal-broker] {msg}", flush=True)


def send_frame(sock, kind, payload):
    if isinstance(payload, str):
        payload = payload.encode("utf-8", "replace")
    try:
        sock.sendall(struct.pack("!BI", kind, len(payload)) + payload)
        return True
    except OSError:
        return False


def read_exactly(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_line(sock, limit=4096):
    """The handshake only. Everything after it is framed."""
    buf = b""
    while b"\n" not in buf:
        if len(buf) > limit:
            return None
        chunk = sock.recv(1)
        if not chunk:
            return None
        buf += chunk
    return buf


def hestia_shell(username):
    """
    The shell HestiaCP has given this account, or None if it has none.

    Read from Hestia's own record rather than from /etc/passwd, because Hestia
    is the thing that decides it — a package sets SHELL, and an account on a
    `nologin` package is one that has deliberately not been given shell access.
    Honouring /etc/passwd instead would hand a shell to accounts the panel says
    do not get one.
    """
    conf = os.path.join(HESTIA_USERS, username, "user.conf")
    if not os.path.isfile(conf):
        return None
    try:
        with open(conf, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("SHELL="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        return None
    return None


def resolve(username):
    """
    Turn a requested username into something safe to become.

    Every one of these refusals is a thing the website could ask for by mistake
    or under attack, and none of them should be reachable by asking politely.
    """
    if not username or not isinstance(username, str):
        return None, "No account named."
    if len(username) > 32 or not all(c.isalnum() or c in "-_" for c in username):
        return None, "That is not a valid account name."
    if username == "root":
        # Never, under any circumstances, and not because Hestia would refuse:
        # Hestia's own admin account is a real login and this must not be a
        # route to it.
        return None, "Not permitted."

    shell = hestia_shell(username)
    if shell is None:
        return None, "No such hosting account on this server."
    if shell in ("nologin", "/sbin/nologin", "/usr/sbin/nologin", "false", "/bin/false"):
        return None, "Shell access is not enabled for this hosting account."

    try:
        entry = pwd.getpwnam(username)
    except KeyError:
        return None, "That account does not exist on this server."
    if entry.pw_uid == 0:
        return None, "Not permitted."

    # Hestia stores a bare name ("bash"); /etc/passwd stores a path. Prefer the
    # real path from passwd, but only if Hestia agrees the account has a shell.
    login_shell = entry.pw_shell if entry.pw_shell else "/bin/bash"
    if login_shell.endswith("nologin") or login_shell.endswith("false"):
        login_shell = "/bin/bash"
    return (entry, login_shell), None


def set_winsize(fd, rows, cols):
    rows = max(1, min(int(rows or 24), 300))
    cols = max(1, min(int(cols or 80), 500))
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def run_session(conn):
    conn.settimeout(30)
    line = read_line(conn)
    if not line:
        return
    try:
        hello = json.loads(line.decode("utf-8", "replace"))
    except ValueError:
        send_frame(conn, TYPE_NOTICE, "Bad handshake.")
        return

    resolved, why = resolve(hello.get("user"))
    if not resolved:
        log(f"refused {hello.get('user')!r}: {why}")
        send_frame(conn, TYPE_NOTICE, why)
        return
    entry, login_shell = resolved
    conn.settimeout(None)

    pid, master = pty.fork()
    if pid == 0:
        # ---- child: drop every privilege before exec, then become the user ----
        try:
            os.setgid(entry.pw_gid)
            os.initgroups(entry.pw_name, entry.pw_gid)
            os.setuid(entry.pw_uid)
            if os.getuid() == 0 or os.geteuid() == 0:
                os._exit(1)  # never exec a shell still holding root
            os.chdir(entry.pw_dir)
        except Exception:
            try:
                os.chdir("/")
            except Exception:
                pass
            if os.geteuid() == 0:
                os._exit(1)

        env = {
            "HOME": entry.pw_dir,
            "USER": entry.pw_name,
            "LOGNAME": entry.pw_name,
            "SHELL": login_shell,
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "TERM": "xterm-256color",
            "LANG": os.environ.get("LANG", "C.UTF-8"),
        }
        os.execve(login_shell, [f"-{os.path.basename(login_shell)}"], env)
        os._exit(1)

    # ---- parent: shuttle bytes, and nothing else ----
    log(f"session open for {entry.pw_name} (pid {pid})")
    set_winsize(master, hello.get("rows"), hello.get("cols"))

    started = time.time()
    last = time.time()
    inbox = b""

    try:
        while True:
            now = time.time()
            if now - last > IDLE_TIMEOUT:
                send_frame(conn, TYPE_NOTICE, "\r\n[disconnected: idle]\r\n")
                break
            if now - started > MAX_SESSION:
                send_frame(conn, TYPE_NOTICE, "\r\n[disconnected: session limit]\r\n")
                break

            ready, _, _ = select.select([conn, master], [], [], 30)

            if master in ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                if not send_frame(conn, TYPE_DATA, chunk):
                    break
                last = now

            if conn in ready:
                try:
                    chunk = conn.recv(65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                inbox += chunk
                last = now

                while len(inbox) >= 5:
                    kind, length = struct.unpack("!BI", inbox[:5])
                    if length > MAX_FRAME:
                        inbox = b""
                        break
                    if len(inbox) < 5 + length:
                        break
                    payload = inbox[5:5 + length]
                    inbox = inbox[5 + length:]

                    if kind == TYPE_DATA:
                        try:
                            os.write(master, payload)
                        except OSError:
                            pass
                    elif kind == TYPE_RESIZE:
                        try:
                            size = json.loads(payload.decode("utf-8", "replace"))
                            set_winsize(master, size.get("rows"), size.get("cols"))
                        except ValueError:
                            pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        # The shell dies with its pty, but a child that ignored the hangup would
        # otherwise be left running as the customer forever.
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        for _ in range(20):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except OSError:
                pass
        log(f"session closed for {entry.pw_name} (pid {pid})")


def main():
    if os.geteuid() != 0:
        log("must run as root — it has to change user, which is the whole point")
        sys.exit(1)

    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)

    # The socket permissions ARE the access control.
    #
    # There is no password and no token on this interface, deliberately: a
    # secret shared with the website would live in the website's .env, and
    # anything that can read that file can already read everything else it has.
    # The unix socket is a better boundary than a shared string — the kernel
    # enforces it, it cannot leak into a log or a backup, and a process outside
    # the group cannot connect at all, whatever it knows.
    #
    # 0660, owned by root and group-owned by the website's own group. Not 0666,
    # which would let any account on the box — including a customer's, which now
    # has a shell — ask for a shell as any other customer.
    try:
        gid = grp.getgrnam(SOCKET_GROUP).gr_gid
        os.chown(SOCKET_PATH, 0, gid)
        os.chmod(SOCKET_PATH, 0o660)
    except KeyError:
        log(f"group {SOCKET_GROUP!r} does not exist — refusing to open the socket to everyone")
        sys.exit(1)

    server.listen(16)
    log(f"listening on {SOCKET_PATH}")

    signal.signal(signal.SIGCHLD, signal.SIG_IGN)

    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            continue
        # One process per session: a wedged pty cannot take the broker with it,
        # and the child holds no state belonging to anyone else.
        if os.fork() == 0:
            server.close()
            # Signal dispositions survive fork, and the accept loop above ignores
            # SIGCHLD so its own session children are auto-reaped. Inheriting that
            # here would make this process's waitpid on the shell raise instead of
            # returning, so the tidy-up at the end of a session could never
            # confirm the shell had actually gone.
            signal.signal(signal.SIGCHLD, signal.SIG_DFL)
            try:
                run_session(conn)
            except Exception as exc:  # never let one session kill the service
                log(f"session error: {exc}")
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
            os._exit(0)
        conn.close()


if __name__ == "__main__":
    main()
