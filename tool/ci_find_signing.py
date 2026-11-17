"""Work out the Azure Trusted (Artifact) Signing endpoint, account and profile.

    python tool/ci_find_signing.py

For the GitHub "Windows - till release" workflow. The repository's secrets hold
the app registration (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) and
the code signing account as CODE_SIGNING_RESOURCE: its Azure resource ID (from
the account's JSON View in the Azure portal), its name, or its endpoint URL.
TRUSTED_SIGNING_ENDPOINT / _ACCOUNT / _PROFILE, when set, are used as they are.

Whatever is missing is asked of Azure Resource Manager with the app
registration, which needs Reader on the signing account (or its resource group)
for that. Writes endpoint=, account= and profile= to $GITHUB_OUTPUT. These are
names, not secrets. Prints names only.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ARM = "https://management.azure.com"
API_VERSIONS = ["2025-10-13", "2024-09-30-preview", "2024-02-05-preview"]


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def http(url, data=None, token=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        data = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"{}")
        except ValueError:
            body = {}
        return e.code, body


def arm_get(path, token):
    """GET an ARM path, trying the CodeSigning API versions in turn."""
    last = None
    for v in API_VERSIONS:
        sep = "&" if "?" in path else "?"
        code, body = http(f"{ARM}{path}{sep}api-version={v}", token=token)
        err = (body.get("error") or {}).get("code", "")
        if code == 400 and "ApiVersion" in err:
            last = (code, body)
            continue
        return code, body
    return last


def main():
    tenant = os.environ.get("AZURE_TENANT_ID", "")
    client = os.environ.get("AZURE_CLIENT_ID", "")
    secret = os.environ.get("AZURE_CLIENT_SECRET", "")
    raw = os.environ.get("CODE_SIGNING_RESOURCE", "").strip()
    endpoint = os.environ.get("TRUSTED_SIGNING_ENDPOINT", "").strip()
    account = os.environ.get("TRUSTED_SIGNING_ACCOUNT", "").strip()
    profile = os.environ.get("TRUSTED_SIGNING_PROFILE", "").strip()

    sub = group = None
    if raw.startswith("/subscriptions/"):
        m = re.search(r"/subscriptions/([^/]+)", raw, re.I)
        sub = m.group(1)
        m = re.search(r"/resourceGroups/([^/]+)", raw, re.I)
        group = m.group(1) if m else None
        m = re.search(r"/codeSigningAccounts/([^/]+)", raw, re.I)
        account = account or (m.group(1) if m else "")
        m = re.search(r"/certificateProfiles/([^/]+)", raw, re.I)
        profile = profile or (m.group(1) if m else "")
    elif raw.lower().startswith("https://"):
        endpoint = endpoint or raw.rstrip("/")
    elif raw:
        # A bare name: the account's, or else its resource group's.
        account = account or raw

    if endpoint and account and profile:
        return done(endpoint, account, profile)

    if not (tenant and client and secret):
        fail("No app registration to ask Azure with (tenant, client id, client secret).")
    code, tok = http(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                     {"grant_type": "client_credentials", "client_id": client,
                      "client_secret": secret, "scope": f"{ARM}/.default"})
    if code != 200:
        fail(f"Azure refused the app registration's sign-in: {tok.get('error')}: "
             f"{(tok.get('error_description') or '').splitlines()[0] if tok.get('error_description') else ''}")
    token = tok["access_token"]

    subs = [sub] if sub else []
    if not subs:
        code, body = http(f"{ARM}/subscriptions?api-version=2022-12-01", token=token)
        subs = [s["subscriptionId"] for s in body.get("value", [])] if code == 200 else []
        if not subs:
            fail("The app registration cannot see any Azure subscription. Give it the Reader role on the "
                 "code signing account (Access control (IAM) > Add role assignment), or add the secrets "
                 "TRUSTED_SIGNING_ENDPOINT (e.g. https://weu.codesigning.azure.net), TRUSTED_SIGNING_ACCOUNT "
                 "and TRUSTED_SIGNING_PROFILE.")

    accounts = []
    for s in subs:
        if group:
            path = f"/subscriptions/{s}/resourceGroups/{group}/providers/Microsoft.CodeSigning/codeSigningAccounts"
        else:
            path = f"/subscriptions/{s}/providers/Microsoft.CodeSigning/codeSigningAccounts"
        code, body = arm_get(path, token)
        if code == 200:
            accounts += body.get("value", [])
        else:
            print(f"  subscription {s[:8]}…: {code} {(body.get('error') or {}).get('code', '')}")
    if account:
        match = [a for a in accounts if a.get("name", "").lower() == account.lower()]
        if not match:
            # The bare name may have been the resource group's.
            match = [a for a in accounts if f"/resourcegroups/{account.lower()}/" in a.get("id", "").lower()]
        accounts = match
    if len(accounts) != 1:
        names = ", ".join(a.get("name", "?") for a in accounts) or "none it can read"
        fail(f"Found {len(accounts)} code signing accounts ({names}). Give the app registration Reader on the "
             "account, or add TRUSTED_SIGNING_ENDPOINT, TRUSTED_SIGNING_ACCOUNT and TRUSTED_SIGNING_PROFILE secrets.")
    acct = accounts[0]
    account = acct["name"]
    endpoint = endpoint or (acct.get("properties") or {}).get("accountUri", "").rstrip("/")
    if not endpoint:
        fail(f"Azure did not give {account}'s endpoint; add it as the TRUSTED_SIGNING_ENDPOINT secret.")

    if not profile:
        code, body = arm_get(f"{acct['id']}/certificateProfiles", token)
        profiles = body.get("value", []) if code == 200 else []
        active = [p for p in profiles if (p.get("properties") or {}).get("status", "Active") == "Active"] or profiles
        public = [p for p in active if (p.get("properties") or {}).get("profileType") == "PublicTrust"]
        pick = public if len(public) == 1 else active
        if len(pick) != 1:
            names = ", ".join(p.get("name", "?") for p in profiles) or "none it can read"
            fail(f"{account} has {len(pick)} usable certificate profiles ({names}); "
                 "add the one to sign with as the TRUSTED_SIGNING_PROFILE secret.")
        profile = pick[0]["name"]
    done(endpoint, account, profile)


def done(endpoint, account, profile):
    print(f"  endpoint: {endpoint}\n  account:  {account}\n  profile:  {profile}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"endpoint={endpoint}\naccount={account}\nprofile={profile}\n")


if __name__ == "__main__":
    main()
