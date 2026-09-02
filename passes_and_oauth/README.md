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

## Moving to a new server

**Nothing in this folder is deployed.** `deploy.ps1` ships only
`vesopa_server/`, and this folder sits outside it — so a fresh box has no
signing material at all, and the back office says so in as many words:

    Apple passes cannot be signed yet.
    APPLE_WALLET_DIR is not set (the folder holding the .p12)
    APPLE_WWDR_CERT is not set (Apple's WWDR intermediate, PEM)

That message *is* the failure. The passes are fine; the server was simply never
told where the key is. Expect to see it on every new server until step 2.

### 1. Put the material on the box

Outside the application directory, so that a deploy cannot overwrite it and a
loose permission on the app cannot expose it:

    W=/home/vesopa/web/<domain>/private/wallet
    ssh root@<host> "mkdir -p $W && chmod 700 $W && chown root:root $W"

Then, from this folder:

    scp "Vesopa Software Ltd Pass Key.p12" root@<host>:$W/vesopa_wallet.p12
    scp loyalty_pass.cer membership_pass.cer giftcard_pass.cer staffcard_pass.cer promotion_pass.cer wwdr.pem root@<host>:$W/
    ssh root@<host> "chmod 600 $W/*"

The names are not arbitrary. The code looks for `vesopa_wallet.p12` and those
exact five `.cer` names — `SHARED_P12` and `CER_FILES` in
`vesopa_server/src/wallet_apple.js`.

### 2. Four lines in the server's .env

Appended to `private/nodeapp/.env`, which a deploy never touches:

    APPLE_WALLET_DIR=<W>
    APPLE_WALLET_CERT_DIR=<W>
    APPLE_WWDR_CERT=<W>/wwdr.pem
    APPLE_WALLET_P12_PASSWORD=<the Pass Key passphrase>

`APPLE_WALLET_CERT_DIR` has to be set explicitly. Its default is this folder
found relative to the app, which exists on a development machine and never on a
server. Then restart so pm2 picks the new variables up:

    pm2 restart vesopa_backoffice --update-env && pm2 save

### 3. Check the server, not your laptop

    cd <app>
    node -e 'require("dotenv").config(); const c = require("./src/wallet_apple").readConfig(process.env); console.log("configured:", c.configured); c.problems.forEach(p => console.log(" -", p));'

`configured: true` with a named bundle means it can sign. Better still, build
one of each kind — signing is where a wrong passphrase or a missing legacy
provider actually shows up.

Needs **OpenSSL 3** on the server. The Keychain export is 3DES, which OpenSSL 3
moved to the legacy provider, and the signing code passes `-legacy`. OpenSSL
1.1.1 does not recognise that flag and fails with a message about providers
that reads like a wrong password.

### 4. While you are in there: the app directory

The first server had `private/nodeapp` at **0777**, on a box with nine shell
accounts. pm2 runs the app as **root**, so any of those accounts could drop a
`.js` file into an application running as root — they never needed to read
`.env` to own it. Fixed to `0755 root:root`, and a new server should start
that way:

    chmod 755 /home/vesopa/web/<domain>/private/nodeapp
    stat -c '%A %U:%G %n' <app> <app>/.env

`.env` must be `0600`. It holds the database password, the JWT secret, and now
the Wallet passphrase as well.

## Push updates: making a card change in somebody's pocket

There is nothing to add in the developer account for this. A Pass Type ID
certificate **is** its own APNs client certificate — the same five `.p12`
bundles that sign a `.pkpass` authenticate the push that updates it. There is no
`.p8` auth key to create, no Key ID, and no App ID: no app of ours runs on the
customer's phone, and none is needed. Wallet does all of it.

What turns it on is one variable:

    APPLE_WALLET_WEB_SERVICE_URL=https://backoffice.vesopaepos.com

An **origin, with no path and no trailing slash**. iOS appends `/v1/...` itself,
and `src/wallet_apple_webservice.js` answers those paths.

### The trap that cannot be fixed afterwards

The address is written *into each pass at the moment it is issued*, and a pass
in a wallet is permanent. Every card issued while this variable was wrong — or
blank — will keep asking the wrong URL forever, and the only repair is to
reissue it to that customer. Get it right before the first card goes out.

The same applies in reverse: blanking the variable later does not stop the cards
already issued from calling. That is why the update routes are mounted whether
or not push is switched on.

### Checking it works

After a deploy, add a card to a real iPhone, then:

    curl -s -H "Authorization: Bearer <token>" \
      https://backoffice.vesopaepos.com/api/wallet/apple/status | jq

`devices_registered` should be 1 within a few seconds of the card being added.
**Zero is the diagnosis**: iOS never reached the web service. It must be
publicly reachable over HTTPS with a valid certificate — iOS will not talk to it
otherwise and says nothing when it will not.

Then change the customer's points and watch the card. Or force it:

    POST /api/wallet/apple/<kind>/<subjectId>/push

which is the same code path a sale takes, with the result kept instead of
discarded. It reports per device, so `BadDeviceToken` arrives as a sentence
rather than as a card that quietly never changes.

### Where the reasons show up

This feature's whole failure mode is silence — no app, no client log, no error.
Three places speak:

| Where | What it tells you |
|---|---|
| `POST /v1/log` → server log | iOS's own complaints. "Authentication failed", "invalid pass". The only channel the phone has. |
| `epos_wallet_devices.last_error` | APNs' rejection for that device, written at the moment it happened. |
| `/api/wallet/apple/status` | Registered and failing device counts per venue. |

A venue with push on and zero registered devices a week later has a wrong
`webServiceURL` baked into its cards. Nothing else in the system would say so.

Production APNs always — `api.push.apple.com`. A pass has no sandbox build, so
its push token is a production token, and sending it to the sandbox host is
answered `BadDeviceToken`: the same error as a genuinely dead device, which is
exactly the wrong thing to be confused about.
