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


KNOWN = {
    "335a71ee-f200-4cb3-9965-dafc3ab0e01b": "Vesopa, the customer sign-in app (personal accounts only: cannot sign or reach the Store)",
    "6ef0452e-04ea-4f22-b580-6a93534978f6": "VesopaEPOS, the Store submission app",
}
PAIRS = [
    ("AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"),
    ("MS_STORE_CLIENT_ID", "MS_STORE_CLIENT_SECRET"),
    ("MICROSOFT_APPLICATION_ID", "MICROSOFT_VESOPA_CLIENT_KEY"),
    ("MICROSOFT_VESOPA_CLIENT_ID", "MICROSOFT_VESOPA_CLIENT_KEY"),
]
TENANTS = ["AZURE_TENANT_ID", "MS_STORE_TENANT_ID", "MICROSOFT_TENANT_ID"]


def sign_in_pairs():
    """Try every client id + secret the environment holds, for Azure and Partner
    Center. Writes sign_pair / store_pair (secret NAMES, id:secret:tenant) to the
    job's outputs and returns an Azure token from the first that works."""
    token = None
    seen = set()
    for id_name, secret_name in PAIRS:
        cid = os.environ.get(id_name, "").strip()
        sec = os.environ.get(secret_name, "").strip()
        if not cid or not sec or (cid, sec) in seen:
            continue
        seen.add((cid, sec))
        label = KNOWN.get(cid.lower(), "an app not named in this repository")
        for t_name in TENANTS:
            tenant = os.environ.get(t_name, "").strip()
            if not tenant:
                continue
            results = {}
            for scope, what in ((f"{ARM}/.default", "Azure"),
                                ("https://manage.devcenter.microsoft.com/.default", "Partner Center")):
                code, tok = http(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                                 {"grant_type": "client_credentials", "client_id": cid,
                                  "client_secret": sec, "scope": scope})
                results[what] = (code, tok)
                why = (tok.get("error_description") or "").split(" Trace ID")[0]
                print(f"  {id_name} + {secret_name} ({label}), tenant {t_name}, {what}: {'ok' if code == 200 else why}")
            pair = f"{id_name}:{secret_name}:{t_name}"
            if results["Azure"][0] == 200 and token is None:
                token = results["Azure"][1]["access_token"]
                write_out("sign_pair", pair)
            if results["Partner Center"][0] == 200 and not os.environ.get("_STORE_DONE"):
                os.environ["_STORE_DONE"] = "1"
                write_out("store_pair", pair)
            if results["Azure"][0] == 200 or results["Partner Center"][0] == 200:
                break
    return token


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

    token = sign_in_pairs()
    if os.environ.get("NO_SIGN"):
        print("  not signing this run: only the Store sign-in above matters")
        return
    if token is None:
        fail("No client id and secret in the environment signs in to Azure (see the lines above), so "
             "nothing can be signed. AZURE_CLIENT_ID / AZURE_CLIENT_SECRET must be the app registration "
             "that has the 'Trusted Signing Certificate Profile Signer' role on the signing account.")
    if endpoint and account and profile:
        return done(endpoint, account, profile)

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


def write_out(key, value):
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def done(endpoint, account, profile):
    print(f"  endpoint: {endpoint}\n  account:  {account}\n  profile:  {profile}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"endpoint={endpoint}\naccount={account}\nprofile={profile}\n")


if __name__ == "__main__":
    main()
