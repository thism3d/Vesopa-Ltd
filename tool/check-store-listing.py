import io, re, sys

def check(path):
    s = io.open(path, encoding='utf-8').read()
    ok = True
    # <!-- FIELD name min max --> then a "## Heading" then body until next <!-- or "---" or next "## "
    for m in re.finditer(r'<!-- FIELD (\w+) (\d+) (\d+) -->\n## [^\n]+\n(.*?)(?=\n<!--|\n---\n|\Z)', s, re.S):
        name, lo, hi, body = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4).strip()
        n = len(body)
        good = lo <= n <= hi
        ok &= good
        print(f"{'OK ' if good else 'BAD'} {name:18} {n:5} chars   (limit {lo}-{hi})")

    fm = re.search(r'<!-- FEATURES (\d+) (\d+) (\d+) -->\n## [^\n]+\n(.*?)(?=\n<!--|\n---\n|\Z)', s, re.S)
    if fm:
        lo, hi, cap = int(fm.group(1)), int(fm.group(2)), int(fm.group(3))
        feats = [l[2:].strip() for l in fm.group(4).strip().split('\n') if l.startswith('- ')]
        cnt_ok = lo <= len(feats) <= hi
        ok &= cnt_ok
        print(f"{'OK ' if cnt_ok else 'BAD'} features           {len(feats):5} items   (need {lo}-{hi})")
        for f in feats:
            good = len(f) <= cap
            ok &= good
            print(f"   {'OK ' if good else 'BAD'} {len(f):3}/{cap}  {f}")
    return ok

allok = True
for p in sys.argv[1:]:
    print(f"===== {p} =====")
    allok &= check(p)
    print()
sys.exit(0 if allok else 1)
