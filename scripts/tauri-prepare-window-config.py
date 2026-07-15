#!/usr/bin/env python3

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "src-tauri" / "fixtures" / "window-config.json"
OUT = ROOT / "out"

if not CONFIG_PATH.exists():
    raise SystemExit(f"missing: {CONFIG_PATH}")

if not OUT.exists():
    raise SystemExit(
        f"missing: {OUT}\n"
        "run `npm run compile` first"
    )

config = json.loads(CONFIG_PATH.read_text())

config["appRoot"] = str(ROOT)
config["windowId"] = 1
config["mainPid"] = 0

config.setdefault("userEnv", {})
config["userEnv"]["VSCODE_DEV"] = "1"
config["userEnv"]["NODE_ENV"] = "development"

# VS Code dev mode imports CSS files as JS module specifiers and
# remaps them through an import map.
config["cssModules"] = sorted(
    path.relative_to(OUT).as_posix()
    for path in OUT.rglob("*.css")
)

CONFIG_PATH.write_text(
    json.dumps(config, ensure_ascii=False, indent=2) + "\n"
)

print(f"updated: {CONFIG_PATH}")
print(f"appRoot: {config['appRoot']}")
print(f"cssModules: {len(config['cssModules'])}")
