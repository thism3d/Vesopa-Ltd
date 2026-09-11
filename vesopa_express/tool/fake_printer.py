"""A network receipt printer that is really a file.

    python tool/fake_printer.py <out-file> [port]

Listens on 127.0.0.1 (port 9100 by default, the raw-printing port every
networked thermal printer answers on) and appends every byte a connection sends
to <out-file>, printing a line per job. Point the kiosk's Receipt printer at
"Network printer, 127.0.0.1" and the ticket it would have printed lands here,
byte for byte, where a test can read it -- the kiosk's real network printing
path, end to end, with no printer on the desk.

Stops on Ctrl+C, or after --once jobs.
"""

import socket
import sys
import time


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    out = args[0]
    port = int(args[1]) if len(args) > 1 else 9100
    once = "--once" in sys.argv

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(4)
    print(f"fake printer on 127.0.0.1:{port} -> {out}", flush=True)
    jobs = 0
    while True:
        conn, _ = server.accept()
        conn.settimeout(10)
        data = b""
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
        except socket.timeout:
            pass
        finally:
            conn.close()
        with open(out, "ab") as f:
            f.write(data)
        jobs += 1
        print(f"{time.strftime('%H:%M:%S')} job {jobs}: {len(data)} bytes", flush=True)
        if once:
            break


if __name__ == "__main__":
    main()
