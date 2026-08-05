# Generates the self-signed code signing certificate used to sign the VESOPA
# EPOS MSIX for sideloading. Run this ONCE, on the Windows build machine, in an
# elevated PowerShell.
#
# The resulting .pfx is the thing that proves a package came from us. It is not
# in the repo and must not be: anyone holding it can sign software as Vesopa
# EPOS Limited. Keep it in the password manager and nowhere else.
#
# Re-running this makes a DIFFERENT certificate. Packages signed with the new
# one will not be seen as upgrades of packages signed with the old one, and
# every till would need the new root installed. Generate once, then guard it.

$ErrorActionPreference = 'Stop'

# Must match `publisher:` in pubspec.yaml exactly, character for character.
$subject = 'CN=Vesopa EPOS Limited, O=Vesopa EPOS Limited, C=GB'

$outDir = Join-Path $PSScriptRoot 'signing'
$pfxPath = Join-Path $outDir 'vesopa-signing.pfx'
$cerPath = Join-Path $outDir 'vesopa-root.cer'

if (Test-Path $pfxPath) {
    throw "$pfxPath already exists. Refusing to overwrite an existing signing key — see the note above about regenerating."
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Three years. Windows checks the signature against the certificate's validity
# window at install time, so a short expiry means reissuing (and re-trusting on
# every till) sooner than you want.
$cert = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $subject `
    -KeyUsage DigitalSignature `
    -FriendlyName 'VESOPA EPOS code signing' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(3) `
    -TextExtension @(
        # Code Signing EKU. Without this Windows will not accept the signature,
        # which is also why a TLS certificate (Let's Encrypt and friends) can
        # never sign an MSIX — those carry server-auth EKUs instead.
        '2.5.29.37={text}1.3.6.1.5.5.7.3.3',
        '2.5.29.19={text}Subject Type:End Entity'
    )

Write-Host "Created certificate with thumbprint $($cert.Thumbprint)"

$password = Read-Host -AsSecureString 'Password to protect the .pfx (store this in the password manager)'

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
# The public half. This is what gets installed on each till — it contains no
# private key and is safe to hand out.
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host ''
Write-Host "Signing key : $pfxPath   (secret — password manager, never the repo)"
Write-Host "Public cert : $cerPath   (safe to distribute, install on each till)"
Write-Host ''
Write-Host 'Next: set the certificate_path / certificate_password in pubspec.yaml or'
Write-Host 'pass them to `dart run msix:create`, then see tool/README-signing.md.'
