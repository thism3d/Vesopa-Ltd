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
| The `.p12` bundles (certificate + key) | Generated from Keychain at build time, kept out of git |
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
