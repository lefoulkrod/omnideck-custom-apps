"""
Unified Hub — Backend Actions

Integrates with the Omnideck broker system to provide calendar and email
access across all connected integrations. Calls brokers directly via the
UDS RPC protocol (4-byte BE length prefix + JSON body).

Integrations available:
  - google_workspace_lefoulkrod: email(rw), calendar(rw), drive(rw), contacts(r)
  - icloud_larry_foulkrod: email(rw), calendar(rw)
"""

from __future__ import annotations

import asyncio
import json
import struct
from pathlib import Path
from typing import Any

# ─── Config ──────────────────────────────────────────────────────────────────

# Integration IDs and their capabilities.
INTEGRATIONS: dict[str, dict[str, list[str]]] = {
    "google_workspace_lefoulkrod": {
        "capabilities": ["email", "calendar", "contacts"],
        "label": "Google Workspace",
    },
    "icloud_larry_foulkrod": {
        "capabilities": ["email", "calendar"],
        "label": "iCloud",
    },
}

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# ─── RPC Protocol ────────────────────────────────────────────────────────────

# The supervisor's app.sock path. We import config (which IS available in -I mode)
# to get this dynamically, with a fallback to the default path.
_APP_SOCK_PATH = "/run/cvault/app.sock"

try:
    from config import load_config
    _APP_SOCK_PATH = load_config().integrations.app_sock_path
except Exception:
    pass


async def _rpc_call(socket_path: str, frame: dict[str, Any]) -> dict[str, Any]:
    """Send one RPC frame over a Unix Domain Socket and read the response.

    Wire format: <4-byte BE length><JSON body>
    """
    reader, writer = await asyncio.open_unix_connection(socket_path)
    try:
        body = json.dumps(frame, separators=(",", ":")).encode("utf-8")
        writer.write(struct.pack(">I", len(body)) + body)
        await writer.drain()
        header = await reader.readexactly(4)
        length = struct.unpack(">I", header)[0]
        if length <= 0 or length > 64 * 1024 * 1024:
            raise RuntimeError(f"invalid frame length: {length}")
        resp_body = await asyncio.wait_for(
            reader.readexactly(length), timeout=5.0
        )
        return json.loads(resp_body.decode("utf-8"))
    finally:
        writer.close()
        await writer.wait_closed()


async def _resolve_broker(integration_id: str) -> str:
    """Resolve an integration ID to its broker socket path via the supervisor."""
    resp = await _rpc_call(
        _APP_SOCK_PATH,
        {"id": 1, "verb": "resolve", "args": {"id": integration_id}},
    )
    if "error" in resp:
        raise RuntimeError(f"resolve failed: {resp['error']}")
    return resp["result"]["socket"]


async def _broker_call(integration_id: str, verb: str, args: dict[str, Any]) -> Any:
    """Resolve integration and call a broker verb in one step."""
    sock = await _resolve_broker(integration_id)
    resp = await _rpc_call(sock, {"id": 1, "verb": verb, "args": args})
    if "error" in resp:
        err = resp["error"]
        raise RuntimeError(f"{err.get('code', 'ERROR')}: {err.get('message', '')}")
    return resp.get("result")


async def _safe_broker_call(
    integration_id: str, verb: str, args: dict[str, Any]
) -> dict[str, Any]:
    """Call a broker verb, catching errors and returning a structured result.

    Returns {"ok": True, "result": ...} or {"ok": False, "error": "..."}.
    """
    try:
        result = await _broker_call(integration_id, verb, args)
        return {"ok": True, "result": result}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "integration_id": integration_id}


# ─── Actions ─────────────────────────────────────────────────────────────────


async def get_dashboard() -> dict[str, Any]:
    """Return upcoming events and recent emails from all integrations.

    Parallelizes calls across integrations to stay within the 8-second timeout.
    Uses "primary" for Google Calendar (a shortcut that works). iCloud calendar
    is skipped in the dashboard because CalDAV list_calendars is slow — users
    can browse iCloud calendars in the Calendar tab.
    """
    email_iids = [iid for iid, info in INTEGRATIONS.items() if "email" in info["capabilities"]]

    # Calendar: only Google (fast "primary" shortcut)
    event_tasks = []
    for iid, info in INTEGRATIONS.items():
        if "calendar" in info["capabilities"] and "google" in iid:
            event_tasks.append((iid, _safe_broker_call(iid, "list_events", {
                "calendar_url": "primary",
                "days_forward": 7,
                "days_back": 0,
                "limit": 10,
            })))

    # Email: list recent messages from INBOX for all email integrations
    msg_tasks = [(iid, _safe_broker_call(iid, "list_messages", {"folder": "INBOX", "limit": 8})) for iid in email_iids]

    all_tasks = event_tasks + msg_tasks
    all_results = await asyncio.gather(*[t[1] for t in all_tasks], return_exceptions=True)

    events_by_integration: dict[str, Any] = {}
    messages_by_integration: dict[str, Any] = {}

    event_iids = {t[0] for t in event_tasks}
    for (iid, _), result in zip(all_tasks, all_results):
        if isinstance(result, Exception):
            data = {"ok": False, "error": str(result), "integration_id": iid}
        else:
            data = {"label": INTEGRATIONS.get(iid, {}).get("label", iid), **result}

        if iid in event_iids and iid not in events_by_integration:
            events_by_integration[iid] = data
        else:
            messages_by_integration[iid] = data

    return {
        "events": events_by_integration,
        "messages": messages_by_integration,
        "integrations": {iid: info["label"] for iid, info in INTEGRATIONS.items()},
    }


async def list_calendars(integration_id: str = "") -> dict[str, Any]:
    """List calendars for one or all integrations."""
    if integration_id:
        result = await _safe_broker_call(integration_id, "list_calendars", {})
        return {integration_id: {"label": INTEGRATIONS.get(integration_id, {}).get("label", integration_id), **result}}

    # All calendar-capable integrations in parallel
    iids = [iid for iid, info in INTEGRATIONS.items() if "calendar" in info["capabilities"]]
    tasks = [(iid, _safe_broker_call(iid, "list_calendars", {})) for iid in iids]
    results = await asyncio.gather(*[t[1] for t in tasks])

    out = {}
    for (iid, _), result in zip(tasks, results):
        out[iid] = {"label": INTEGRATIONS[iid]["label"], **result}
    return out


async def list_events(
    integration_id: str,
    calendar_url: str = "primary",
    days_forward: int = 30,
    days_back: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    """List events from a specific calendar."""
    result = await _safe_broker_call(integration_id, "list_events", {
        "calendar_url": calendar_url,
        "days_forward": days_forward,
        "days_back": days_back,
        "limit": limit,
    })
    return result


async def create_event(
    integration_id: str,
    calendar_id: str,
    summary: str,
    start: str,
    end: str,
    description: str = "",
    location: str = "",
) -> dict[str, Any]:
    """Create a new calendar event.

    Args:
        integration_id: Which integration to use.
        calendar_id: Calendar ID (from list_calendars).
        summary: Event title.
        start: RFC 3339 datetime or date string.
        end: RFC 3339 datetime or date string.
        description: Optional event description.
        location: Optional event location.
    """
    args: dict[str, Any] = {
        "calendar_id": calendar_id,
        "summary": summary,
        "start": start,
        "end": end,
    }
    if description:
        args["description"] = description
    if location:
        args["location"] = location
    result = await _safe_broker_call(integration_id, "create_event", args)
    return result


async def list_mailboxes(integration_id: str = "") -> dict[str, Any]:
    """List mailboxes for one or all email integrations."""
    if integration_id:
        result = await _safe_broker_call(integration_id, "list_mailboxes", {})
        return {integration_id: {"label": INTEGRATIONS.get(integration_id, {}).get("label", integration_id), **result}}

    iids = [iid for iid, info in INTEGRATIONS.items() if "email" in info["capabilities"]]
    tasks = [(iid, _safe_broker_call(iid, "list_mailboxes", {})) for iid in iids]
    results = await asyncio.gather(*[t[1] for t in tasks])

    out = {}
    for (iid, _), result in zip(tasks, results):
        out[iid] = {"label": INTEGRATIONS[iid]["label"], **result}
    return out


async def list_messages(
    integration_id: str,
    folder: str = "INBOX",
    limit: int = 20,
) -> dict[str, Any]:
    """List messages from a mailbox."""
    result = await _safe_broker_call(integration_id, "list_messages", {
        "folder": folder,
        "limit": limit,
    })
    return result


async def search_messages(
    integration_id: str,
    query: str,
    folder: str = "INBOX",
    limit: int = 20,
) -> dict[str, Any]:
    """Search messages in a mailbox."""
    result = await _safe_broker_call(integration_id, "search_messages", {
        "folder": folder,
        "query": query,
        "limit": limit,
    })
    return result


async def fetch_message(
    integration_id: str,
    folder: str,
    uid: str,
) -> dict[str, Any]:
    """Fetch a full message (header + body)."""
    result = await _safe_broker_call(integration_id, "fetch_message", {
        "folder": folder,
        "uid": uid,
    })
    return result


async def send_message(
    integration_id: str,
    to: str,
    subject: str,
    body: str,
) -> dict[str, Any]:
    """Send an email.

    Args:
        integration_id: Which integration to send through.
        to: Comma-separated recipient addresses.
        subject: Email subject.
        body: Plain text email body.
    """
    recipients = [addr.strip() for addr in to.split(",") if addr.strip()]
    if not recipients:
        return {"ok": False, "error": "At least one recipient is required."}
    result = await _safe_broker_call(integration_id, "send_message", {
        "to": recipients,
        "subject": subject,
        "body": body,
    })
    return result


async def get_integrations() -> dict[str, Any]:
    """Return available integrations and their capabilities."""
    return {
        iid: {
            "label": info["label"],
            "capabilities": info["capabilities"],
        }
        for iid, info in INTEGRATIONS.items()
    }


# ─── Action Registry ─────────────────────────────────────────────────────────

actions = {
    "get_dashboard": get_dashboard,
    "list_calendars": list_calendars,
    "list_events": list_events,
    "create_event": create_event,
    "list_mailboxes": list_mailboxes,
    "list_messages": list_messages,
    "search_messages": search_messages,
    "fetch_message": fetch_message,
    "send_message": send_message,
    "get_integrations": get_integrations,
}