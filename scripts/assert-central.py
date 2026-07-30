#!/usr/bin/env python3
"""Assert the merged, centrally-compared result: clean run must be exit 0."""
import json, sys

d = json.load(open("central.json"))
s = d["summary"]
print("summary:", json.dumps(s))
print("missing:", d.get("missingBaselines"))

errs = []
if s["total"] != 8:   errs.append(f"expected 8 snapshots, got {s['total']}")
if s["missing"] != 0: errs.append(f"expected 0 missing, got {s['missing']}: {d.get('missingBaselines')}")
if s["passed"] != 8:  errs.append(f"expected 8 passed, got {s['passed']}")

code = int(sys.argv[1])
if code != 0: errs.append(f"expected exit 0, got {code}")

for e in errs: print(f"::error::{e}")
sys.exit(1 if errs else 0)
