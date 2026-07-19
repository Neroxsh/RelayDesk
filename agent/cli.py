"""Python launcher for the Node-based RelayDesk desktop bridge."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

DEFAULT_RELAY = "https://relay.xingshihao.site"
CONTROL_URL = "http://127.0.0.1:43127"
RUN_VALUE = "RelayDeskAgent"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="relaydesk", description="Run the RelayDesk desktop bridge")
    result.add_argument(
        "command",
        nargs="?",
        choices=("setup", "start", "control", "pair", "status"),
        default="setup",
    )
    result.add_argument("--relay", default=os.environ.get("RELAYDESK_URL", DEFAULT_RELAY))
    result.add_argument("--dry-run", action="store_true")
    result.add_argument("--no-open", action="store_true")
    return result


def online() -> bool:
    try:
        with urllib.request.urlopen(CONTROL_URL, timeout=0.6) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def startup_command(node: str, agent: Path, relay: str) -> str:
    return f'"{node}" "{agent}" start --relay "{relay}"'


def install_startup(command: str) -> None:
    if sys.platform != "win32":
        return
    import winreg

    path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, command)


def start_background(node: str, agent: Path, relay: str) -> None:
    flags = 0
    if sys.platform == "win32":
        flags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NO_WINDOW
        )
    subprocess.Popen(
        [node, str(agent), "start", "--relay", relay],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=flags,
        start_new_session=sys.platform != "win32",
    )


def print_links(relay: str) -> None:
    print("RelayDesk")
    print(f"  Desktop  {CONTROL_URL}")
    print(f"  Phone    {relay}")


def main() -> int:
    args = parser().parse_args()
    relay = args.relay.rstrip("/")
    node = shutil.which("node")
    if not node:
        print("RelayDesk requires Node.js 22 or newer.", file=sys.stderr)
        return 2
    major = int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True).strip())
    if major < 22:
        print("RelayDesk requires Node.js 22 or newer.", file=sys.stderr)
        return 2
    agent = Path(__file__).with_name("index.mjs")
    command = [node, str(agent), args.command, "--relay", relay]
    print_links(relay)
    if args.dry_run:
        return 0
    if args.command == "status":
        print("  Status   running" if online() else "  Status   stopped")
        return 0 if online() else 1
    if args.command == "setup":
        if sys.platform == "win32":
            install_startup(startup_command(node, agent, relay))
        if not online():
            start_background(node, agent, relay)
            for _ in range(40):
                if online():
                    break
                time.sleep(0.1)
        if not args.no_open:
            webbrowser.open(CONTROL_URL)
        print("First connection: enter the pairing code on your phone, then approve it here.")
        return 0
    if args.command in {"control", "pair"} and not online():
        print("RelayDesk is not running. Run `relaydesk setup` first.", file=sys.stderr)
        return 1
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
