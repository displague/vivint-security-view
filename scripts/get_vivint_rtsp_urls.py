#!/usr/bin/env python3
"""Fetch Vivint camera RTSP URLs (direct/internal/external) without PubNub."""

from __future__ import annotations

import asyncio
import getpass
import json
import sys
from pathlib import Path


def _add_local_vivintpy_to_path() -> None:
    root = Path(__file__).resolve().parents[1]
    local_pkg = root / "references" / "vivintpy"
    if not local_pkg.exists():
        raise SystemExit(
            f"Missing {local_pkg}. Clone the repo first into references/vivintpy."
        )
    sys.path.insert(0, str(local_pkg))


_add_local_vivintpy_to_path()

from vivintpy.account import Account  # noqa: E402
from vivintpy.devices.camera import Camera  # noqa: E402
from vivintpy.exceptions import VivintSkyApiMfaRequiredError  # noqa: E402


async def _collect_urls() -> dict:
    username = input("Vivint username/email: ").strip()
    password = getpass.getpass("Vivint password: ")

    account = Account(username=username, password=password)
    try:
        try:
            await account.connect(load_devices=True, subscribe_for_realtime_updates=False)
        except VivintSkyApiMfaRequiredError:
            code = input("Enter MFA code: ").strip()
            await account.verify_mfa(code)

        output: dict[str, list[dict]] = {"cameras": []}
        for system in account.systems:
            for panel in system.alarm_panels:
                for device in panel.devices:
                    if not isinstance(device, Camera):
                        continue

                    output["cameras"].append(
                        {
                            "system_id": system.id,
                            "panel_id": panel.id,
                            "partition_id": panel.partition_id,
                            "camera_name": device.name,
                            "camera_id": device.id,
                            "camera_ip": device.ip_address,
                            "direct_rtsp_hd": await device.get_direct_rtsp_url(hd=True),
                            "direct_rtsp_sd": await device.get_direct_rtsp_url(hd=False),
                            "internal_rtsp_hd": await device.get_rtsp_url(
                                internal=True, hd=True
                            ),
                            "internal_rtsp_sd": await device.get_rtsp_url(
                                internal=True, hd=False
                            ),
                            "external_rtsp_hd": await device.get_rtsp_url(
                                internal=False, hd=True
                            ),
                            "external_rtsp_sd": await device.get_rtsp_url(
                                internal=False, hd=False
                            ),
                        }
                    )
        return output
    finally:
        await account.disconnect()


def main() -> None:
    result = asyncio.run(_collect_urls())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
