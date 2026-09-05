#!/usr/bin/env python
"""Run a command on the live Vesopa server, or copy files to it.

Windows has no sshpass and no rsync, and `ssh` here cannot be handed a password
non-interactively — so this is the way in. Paramiko does password auth and SFTP
in one library and needs nothing installed on the far end.

    set -a; . ./.env.claude-tools; set +a

    python vesopa_ssh.py run "pm2 status"
    python vesopa_ssh.py put <local-dir> <remote-dir> [--exclude node_modules .git]
    python vesopa_ssh.py get <remote-file> <local-file>

Reads VESOPA_SSH_HOST (user@host) and VESOPA_SSH_PASSWORD from the environment.
Nothing is written to the server unless the command says to.
"""

import io
import os
import posixpath
import stat
import sys

import paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

DEFAULT_EXCLUDES = {
    ".git", "node_modules", ".env", "backup", "shots",
    "__pycache__", ".DS_Store",
}


def settings():
    """Read .env.claude-tools directly, not through the shell.

    Git Bash rewrites anything that looks like a POSIX path when it hands the
    environment to a native Windows program, so a remote path exported from the
    shell arrives here as `C:/Program Files/Git/home/vesopa/...` and every SFTP
    call fails with "No such file". Reading the file ourselves sidesteps the
    conversion entirely — and means the script works whether or not anybody
    remembered to source it.

    A real environment variable still wins, so a one-off override works.
    """
    values = {}
    root = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):  # walk up to the repository root
        candidate = os.path.join(root, ".env.claude-tools")
        if os.path.isfile(candidate):
            for line in io.open(candidate, encoding="utf-8"):
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
            break
        root = os.path.dirname(root)
    values.update({k: v for k, v in os.environ.items() if k.startswith("VESOPA_")})
    return values


def connect():
    config = settings()
    target = config.get("VESOPA_SSH_HOST", "")
    password = config.get("VESOPA_SSH_PASSWORD")
    if not target or not password:
        raise SystemExit(
            "VESOPA_SSH_HOST and VESOPA_SSH_PASSWORD not found in "
            ".env.claude-tools or the environment"
        )
    user, _, host = target.partition("@")
    if not host:
        user, host = "root", target

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=host, username=user, password=password,
        timeout=30, banner_timeout=30, auth_timeout=30,
        look_for_keys=False, allow_agent=False,
    )
    return client


def run(client, command):
    """Run one command. Returns the exit status; streams both channels."""
    stdin, stdout, stderr = client.exec_command(command, timeout=600)
    stdin.close()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    if out:
        print(out, end="" if out.endswith("\n") else "\n")
    if err:
        print(err, end="" if err.endswith("\n") else "\n", file=sys.stderr)
    return status


def _mkdirs(sftp, path):
    parts = path.strip("/").split("/")
    here = ""
    for part in parts:
        here = f"{here}/{part}"
        try:
            sftp.stat(here)
        except IOError:
            sftp.mkdir(here)


def put(client, local, remote, excludes):
    """Upload a directory tree, skipping `excludes` by name at any depth."""
    sftp = client.open_sftp()
    sent = 0
    try:
        local = os.path.abspath(local)
        _mkdirs(sftp, remote)

        for root, dirs, files in os.walk(local):
            dirs[:] = [d for d in dirs if d not in excludes]
            rel = os.path.relpath(root, local).replace("\\", "/")
            target = remote if rel == "." else posixpath.join(remote, rel)
            if rel != ".":
                try:
                    sftp.stat(target)
                except IOError:
                    _mkdirs(sftp, target)

            for name in files:
                if name in excludes:
                    continue
                source = os.path.join(root, name)
                destination = posixpath.join(target, name)
                sftp.put(source, destination)
                # Keep the executable bit on anything that had one locally;
                # deploy scripts and hooks stop working without it.
                if os.access(source, os.X_OK):
                    sftp.chmod(destination, 0o755)
                sent += 1
                if sent % 50 == 0:
                    print(f"  … {sent} files", flush=True)
    finally:
        sftp.close()
    print(f"uploaded {sent} files to {remote}")


def get(client, remote, local):
    sftp = client.open_sftp()
    try:
        info = sftp.stat(remote)
        if stat.S_ISDIR(info.st_mode):
            raise SystemExit("get takes a file, not a directory")
        os.makedirs(os.path.dirname(os.path.abspath(local)) or ".", exist_ok=True)
        sftp.get(remote, local)
    finally:
        sftp.close()
    print(f"downloaded {remote} -> {local}")


def _resolve(remote):
    """Expand a leading `@app` to the deployed application's directory."""
    if remote == "@app" or remote.startswith("@app/"):
        base = settings().get("VESOPA_REMOTE_APP")
        if not base:
            raise SystemExit("VESOPA_REMOTE_APP is not set")
        return base if remote == "@app" else posixpath.join(base, remote[5:])
    return remote


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)

    action, rest = args[0], args[1:]
    excludes = set(DEFAULT_EXCLUDES)
    if "--exclude" in rest:
        i = rest.index("--exclude")
        excludes.update(rest[i + 1:])
        rest = rest[:i]

    client = connect()
    try:
        if action == "run":
            # `@app` works here too, for the same reason.
            command = " ".join(rest).replace(
                "@app", settings().get("VESOPA_REMOTE_APP", "@app")
            )
            sys.exit(run(client, command))
        if action == "put":
            if len(rest) != 2:
                raise SystemExit("put <local-dir> <remote-dir>")
            # `@app/src` means "under VESOPA_REMOTE_APP", so the remote path
            # never has to travel through the shell and be rewritten.
            put(client, rest[0], _resolve(rest[1]), excludes)
            return
        if action == "get":
            if len(rest) != 2:
                raise SystemExit("get <remote-file> <local-file>")
            get(client, rest[0], rest[1])
            return
        raise SystemExit(f"unknown action: {action}")
    finally:
        client.close()


if __name__ == "__main__":
    main()
