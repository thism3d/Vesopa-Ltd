# Apple Wallet signing material

The five pass type certificates issued to **Vesopa Software Ltd**, team
`G238FR2ZC9`, for the passes described in `vesopa_server/src/wallet_google.js`.

## What is here, and what is deliberately not

Only the `.cer` files are committed. A `.cer` is the **public** half of a
certificate: it identifies the pass type and proves Apple issued it, and it
cannot sign a pass by itself. It is the equivalent of publishing a padlock.

Everything that can actually sign is **not** in this repository and must never
be:

| Not here | Where it lives |
|---|---|
| The private key for each certificate | macOS Keychain on the machine that generated the CSR |
| The `.p12` bundles (certificate + key) | Generated from Keychain, kept out of git — see below for which one |
| `CertificateSigningRequest.certSigningRequest` | Local only — a one-time artefact, of no ongoing use |
| The Google OAuth client secret | Local only, and outside any repository |
| Apple's WWDR intermediate | Fetched from Apple at build time |

The `.gitignore` here denies everything and allows the five certificates back
by name, rather than listing what to deny. A new secret dropped into this
directory is therefore ignored by default, which is the only arrangement that
survives somebody being in a hurry.

## The certificates

| File | Pass type identifier | Kind in the code | Apple style | Expires |
|---|---|---|---|---|
| `loyalty_pass.cer` | `pass.com.vesopa.loyalty` | `loyalty` | storeCard | 2 Oct 2027 |
| `membership_pass.cer` | `pass.com.vesopa.membership` | `customer` | storeCard | 2 Oct 2027 |
| `giftcard_pass.cer` | `pass.com.vesopa.giftcard` | `giftcard` | storeCard | 2 Oct 2027 |
| `staffcard_pass.cer` | `pass.com.vesopa.staff` | `staff` | generic | 2 Oct 2027 |
| `promotion_pass.cer` | `pass.com.vesopa.promotions` | `promo` | coupon | 2 Oct 2027 |

Note the last row. The identifier is **`promotions`**, plural — the certificate
says so and the certificate is the authority, because it is already issued and
cannot be renamed. `PASS_TYPES` in `wallet_google.js` matches it. A `.pkpass`
whose `passTypeIdentifier` differs from its signing certificate by one letter
is rejected by Apple with an error that does not name the field, so this is a
half-day of debugging avoided by writing it down once.

Note also that the internal kind for a membership card is `customer`. That
name predates the Apple identifiers and is spelled that way across four tables
and a settings screen; it is not worth a rename.

## Which .p12 signs these certificates

**`Vesopa Software Ltd Pass Key.p12`.** Password is the one kept with the rest
of the deployment secrets, not written down here.

There are two `.p12` files in this folder and only that one works. The other,
`Vesopa Software Ltd Certificate Key.p12`, holds a **different keypair** — it
opens with the same password and looks entirely plausible, and its public half
matches none of the five certificates above. Signing with it produces a pass
that is perfectly formed, installs on nothing, and reports nothing anywhere.

Verified by comparing public halves:

    export P12PASS='…'
    CERT=$(openssl x509 -inform DER -in loyalty_pass.cer -pubkey -noout            | openssl sha256)
    for f in *.p12; do
      KEY=$(openssl pkcs12 -in "$f" -nocerts -nodes -passin env:P12PASS -legacy             | openssl pkey -pubout | openssl sha256)
      [ "$KEY" = "$CERT" ] && echo "MATCHES  $f" || echo "different $f"
    done

`src/wallet_apple.js` does exactly this at start-up rather than trusting a
filename, so dropping both files in one folder is safe. It was not always: an
earlier version picked by name and chose the wrong one, because Keychain Access
names an export after whatever was selected when it was made.

The two `.pem` files here are **public keys** and cannot sign — `openssl` says
"Could not find private key" for both. The `.certSigningRequest` is spent: Apple
consumed it when it issued the five certificates.

## Apple's WWDR intermediate

Needed to sign, and not committed — it expires, and a stale copy in git outlives
the day anybody notices. Fetch it into this folder, where the deny-everything
rule keeps it local:

    curl -o wwdr.cer https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
    openssl x509 -inform DER -in wwdr.cer -out wwdr.pem && rm wwdr.cer

G4 expires 10 December 2030. Without it in the chain a device has no path from
the signing certificate to Apple's root, and the pass will not install on a
phone that has not seen the intermediate before.

## Signing a sample, and testing it properly

    cd ../vesopa_server
    APPLE_WALLET_DIR=../passes_and_oauth     APPLE_WWDR_CERT=../passes_and_oauth/wwdr.pem     APPLE_WALLET_P12_PASSWORD=…     node tools/make-sample-passes.js

That writes one card of each kind to `samples/` — also ignored. AirDrop one to
an iPhone or email it to yourself.

**Do this before believing the tests.** `test/wallet-apple-signing.test.js`
checks the signature the way openssl sees it, and iOS applies rules of its own:
image dimensions, field counts, whether Apple still recognises the certificate.
A pass that opens in Wallet is the only proof that counts — and if something is
wrong, the only error anybody ever sees is "Safari cannot download this file".

The same suite runs against the real material when the three variables above are
set, and skips itself, saying why, when they are not.

## Renewal

All five expire on **2 October 2027**. They are renewed at
`developer.apple.com` → Certificates, Identifiers & Profiles → Identifiers →
Pass Type IDs, with a fresh CSR from Keychain Access.

Renewing does **not** invalidate passes already in people's phones — those are
signed and stay valid — but a certificate that has lapsed cannot sign a new one
and cannot push an update to an existing one. Which presents as "passes stopped
updating", not as "a certificate expired".

## Verifying one

    openssl x509 -inform DER -in loyalty_pass.cer -noout -subject -enddate
