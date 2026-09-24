"""Ask Kimi (Moonshot) for a long piece of writing and save it to a file.

    python tool/kimi.py <prompt-file> <output-file> [model] [max_tokens]

The key is read out of .env.claude-tools rather than sourced, because Git Bash
rewrites POSIX-looking values on their way to a native Windows program. It is
never printed, and provider error bodies are scrubbed before they are shown —
an error can quote the credential back.

Three things about this provider that look like a broken key and are not:
reasoning tokens come out of max_tokens, so a small ceiling returns an empty
string; the rate limit is three requests a minute with a concurrency of one;
and some models refuse any temperature but 1, so none is sent.
"""
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]


def env():
    values = {}
    for line in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def scrub(text, secret):
    return text.replace(secret, "<key>") if secret else text


def main():
    prompt_file = pathlib.Path(sys.argv[1])
    out_file = pathlib.Path(sys.argv[2])
    model = sys.argv[3] if len(sys.argv) > 3 else "kimi-k3"
    max_tokens = int(sys.argv[4]) if len(sys.argv) > 4 else 16000

    cfg = env()
    key = cfg["KIMI_API_KEY"]
    base = cfg.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1").rstrip("/")

    prompt = prompt_file.read_text(encoding="utf-8")
    body = json.dumps(
        {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=1200) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = scrub(e.read().decode("utf-8", "replace"), key)
        print(f"HTTP {e.code}: {detail[:2000]}", file=sys.stderr)
        raise SystemExit(1)

    choice = payload["choices"][0]
    text = choice["message"].get("content") or ""
    usage = payload.get("usage", {})
    # Strip a fenced wrapper if the model wrapped the whole document in one.
    fenced = re.match(r"^\s*```(?:markdown|md)?\n(.*)\n```\s*$", text, re.S)
    if fenced:
        text = fenced.group(1)

    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(text, encoding="utf-8")
    print(
        f"model={model} finish={choice.get('finish_reason')} "
        f"chars={len(text)} usage={usage}"
    )


if __name__ == "__main__":
    main()
