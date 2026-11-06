"""Printer profile signing: the two steps on the live server.

    python tool/print_profile_cert.py request           # prints the CSR, base64
    python tool/print_profile_cert.py install <x.cer>   # installs Apple's answer

`request` makes the private key on the server if there is none yet, so the key
never leaves it. In between, run .github/workflows/print-profile-cert.yml with
that CSR and download print-profile.cer. Run all this again each year, before
the certificate runs out; profiles go out unsigned after that.
"""
import pathlib
import shutil
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import update_venue_versions as venue  # noqa: E402  (its ssh helper and paths)

DIR = f"{venue.BACKOFFICE}/data/print-signing"
G3 = "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer"


def request():
    venue.ssh(
        "run",
        f"set -e; sudo -u {venue.USER} mkdir -p {DIR}; chmod 700 {DIR}; cd {DIR}; "
        f"[ -f key.pem ] || sudo -u {venue.USER} sh -c 'umask 077; openssl genrsa -out key.pem 2048 2>/dev/null'; "
        f"openssl req -new -key key.pem -subj '/CN=Vesopa Print Profiles/O=Vesopa Software Ltd/C=GB' | base64 -w0; echo",
    )


def install(cer):
    stage = pathlib.Path(tempfile.mkdtemp(prefix="pps-"))
    shutil.copy(cer, stage / "cert.cer")
    with urllib.request.urlopen(G3) as r:
        (stage / "wwdr.cer").write_bytes(r.read())
    venue.ssh("put", str(stage), "/tmp/.ppsstage")
    venue.ssh(
        "run",
        f"set -e; cd {DIR}; "
        f"openssl x509 -inform DER -in /tmp/.ppsstage/cert.cer -out cert.pem; "
        f"openssl x509 -inform DER -in /tmp/.ppsstage/wwdr.cer -out chain.pem; rm -rf /tmp/.ppsstage; "
        # The certificate has to be for this key, or nothing it signs will check.
        f'[ "$(openssl x509 -in cert.pem -noout -pubkey | sha256sum)" = "$(openssl pkey -in key.pem -pubout | sha256sum)" ]; '
        f"chown {venue.USER}:{venue.USER} cert.pem chain.pem; "
        f"openssl x509 -in cert.pem -noout -subject -enddate",
    )


if __name__ == "__main__":
    if sys.argv[1:2] == ["request"]:
        request()
    elif sys.argv[1:2] == ["install"] and len(sys.argv) == 3:
        install(sys.argv[2])
    else:
        print(__doc__)
