# Signing and distributing the Windows till

The till is distributed as a sideloaded MSIX — installed directly onto machines
we or the customer control, not through the Microsoft Store.

This has one consequence that shapes everything below: the package is signed
with a **self-signed** certificate, which Windows does not trust by default.
Each till needs our root installed once, before its first install. After that,
every future release signed with the same certificate installs without ceremony.

If you ever want a package a stranger can download and double-click with no
setup step, self-signing cannot do it — that needs a certificate bought from a
public CA. See "When to buy a real certificate" at the end.

## One-time, on the build machine

Run in an elevated PowerShell:

    pwsh tool/new-signing-cert.ps1

It writes two files into `tool/signing/` (which is gitignored):

| File | What it is | Handling |
|---|---|---|
| `vesopa-signing.pfx` | Private key. Signs releases. | **Secret.** Password manager. Never the repo, never email. |
| `vesopa-root.cer` | Public half. | Safe to hand out. Goes on every till. |

Anyone with the `.pfx` and its password can sign software that Windows will
present as coming from Vesopa EPOS Limited. Treat it like a production
credential, because that is what it is.

Run the script **once**. Regenerating produces a different certificate, and
Windows will not treat packages signed by the new one as upgrades of packages
signed by the old — every till would need re-trusting and possibly a reinstall.

## Building a release

Bump `msix_version` in `pubspec.yaml` first. Four parts, and it must increase
on every build you hand out — Windows uses it to decide whether a package is an
upgrade, and installing an equal version is a no-op that looks exactly like the
update silently failing.

    flutter build windows --release
    dart run msix:create `
      --certificate-path tool/signing/vesopa-signing.pfx `
      --certificate-password <password>

The default build already points at the live server (see
`lib/config/constants.dart`), so no extra flags are needed for a production
package. A local-server build is the one that needs
`--dart-define=USE_LIVE_SERVER=false`.

Output: `build/windows/x64/runner/Release/vesopa_epos.msix`

Passing the password on the command line puts it in your shell history. On a
shared build machine, prefer setting it from an environment variable.

## Installing on a till

**First time on a given machine**, install the root. Elevated PowerShell:

    Import-Certificate -FilePath vesopa-root.cer `
      -CertStoreLocation Cert:\LocalMachine\Root

This is the step that makes our signature trustworthy on that machine. It
requires administrator rights, so on customer-managed hardware their IT may
need to do it — or push it via Group Policy / Intune across a fleet, which is
the sane approach beyond a handful of tills.

**Then, and for every release after:** double-click the `.msix`.

Only the first install needs the certificate step. Later releases signed with
the same certificate upgrade in place.

## When to buy a real certificate

Self-signing is legitimate and standard for managed deployments, and is a fine
place to stay while the till only goes onto machines someone will set up.

It stops being viable when you want a public download link. Then every user
hits both a SmartScreen warning and a manual trust step they have no reason to
trust — a support burden per install, on an EPOS product.

At that point: an OV code signing certificate (Sectigo, SSL.com, DigiCert,
Certum) runs roughly £200–400/year. Since June 2023 the private key must live
on a hardware token or cloud HSM, and issuance involves verifying the company —
allow days to weeks. EV certificates cost more and carry SmartScreen reputation
from day one; OV builds reputation over time.

Migrating is not disruptive: change `publisher:` in `pubspec.yaml` to the new
certificate's subject DN exactly, and sign with the new key. Keep
`identity_name` unchanged so existing installs still upgrade.
