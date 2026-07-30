#!/usr/bin/env python3
"""Assert a real change still fails through the sharded path, with layers intact."""
import json, sys

d = json.load(open("regress.json"))
s = d["summary"]
print("summary:", json.dumps(s))

styles = {x.get("dom", {}).get("styleCheck") for x in d["snapshots"]}
print("styleCheck values:", styles)

errs = []
if s["changed"] != 8: errs.append(f"expected 8 changed, got {s['changed']}")
if s["missing"] != 0: errs.append(f"expected 0 missing, got {s['missing']}")
# proves element maps survived capture → artifact → cross-machine compare
if "mismatch" not in styles: errs.append("element maps did not survive the shard round-trip")

code = int(sys.argv[1])
if code != 1: errs.append(f"expected exit 1, got {code}")

for e in errs: print(f"::error::{e}")
sys.exit(1 if errs else 0)
