"""Run the Vesopa OAuth planning prompts through Kimi K3, one after another.

Moonshot allows three requests a minute with a concurrency of one, and a
substantial answer takes ten to twenty minutes, so this runs sequentially in the
background and writes each answer as it lands. Nothing here is interactive: the
point is to start it and go and build something else.

    python tool/kimi_plan.py

Each answer is written the moment it arrives, so a later failure never costs an
earlier section.
"""
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLAN = ROOT / "vesopa_auth" / "plan"

SECTIONS = [
    ("a", "prompt-a-identity-model.md", "kimi-a-identity-model.md"),
    ("b", "prompt-b-protocol-security.md", "kimi-b-protocol-security.md"),
    ("c", "prompt-c-mfa-passkeys.md", "kimi-c-mfa-passkeys.md"),
    ("d", "prompt-d-product-and-build.md", "kimi-d-product-and-build.md"),
]

MAX_TOKENS = "30000"


def main():
    log = PLAN / "kimi-run.log"
    log.parent.mkdir(parents=True, exist_ok=True)

    def say(line):
        stamp = time.strftime("%H:%M:%S")
        with log.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {line}\n")
        print(f"[{stamp}] {line}", flush=True)

    say(f"starting {len(SECTIONS)} sections")
    for index, (tag, prompt_name, out_name) in enumerate(SECTIONS):
        prompt = PLAN / prompt_name
        out = PLAN / out_name
        say(f"section {tag}: asking kimi-k3 ({prompt_name})")
        started = time.time()
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tool" / "kimi.py"),
                str(prompt),
                str(out),
                "kimi-k3",
                MAX_TOKENS,
            ],
            capture_output=True,
            text=True,
        )
        took = int(time.time() - started)
        if result.returncode != 0:
            say(f"section {tag}: FAILED after {took}s :: {result.stderr.strip()[:400]}")
        else:
            chars = out.stat().st_size if out.exists() else 0
            say(f"section {tag}: done in {took}s, {chars} bytes :: {result.stdout.strip()}")
        # Three requests a minute; leave room even when a call returns fast.
        if index != len(SECTIONS) - 1:
            time.sleep(25)
    say("all sections finished")


if __name__ == "__main__":
    main()
