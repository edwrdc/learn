"""Read the format-2 durable transcript (one SQLite database per chat).

The app writes the transcript through pi-durable: every entry is one immutable
row in the root conversation, and the record's message list is a projection over
those rows (see src/store/durable.ts). This module reproduces only that
projection. It imports no application code, starts nothing, and writes nothing
inside the selected data folder.

SQLite creates or rewrites the -shm shared-memory file for a WAL database even
on a read-only connection. When WAL sidecar files exist, the reader copies the
database and its WAL into a temporary directory outside the data folder and reads
the copy. Otherwise it reads the database in immutable mode, which creates nothing.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from typing import Any

from _data import DataError, safe_path

# pi-durable 1.4.0 writes schema version 2; version 1 has the same entry and
# conversation tables, so both are readable without migrating anything.
SCHEMA_VERSION = 2
# The reserved root conversation holds the public chat transcript. Job and
# sub-agent conversations live in the same database and are not the record.
ROOT_CONVERSATION = 1
# Bookkeeping the app projection hides: the continuation input that starts a
# reaction run and positional system prompts.
HIDDEN_KINDS = {"lh.continuation", "pi.system"}


def _reject_constant(value: str) -> None:
    raise ValueError(f"Non-JSON numeric constant: {value}")


def _entry(entry_id: int, raw: Any) -> dict[str, Any]:
    """Validate one stored entry record at the database boundary."""
    try:
        entry = json.loads(raw, parse_constant=_reject_constant)
    except (TypeError, ValueError) as exc:
        raise DataError(f"Durable entry {entry_id} is not readable JSON: {exc}") from exc
    if not isinstance(entry, dict) or entry.get("id") != entry_id or entry.get("conversationId") != ROOT_CONVERSATION:
        raise DataError(f"Durable entry {entry_id} does not match its stored identity or root conversation.")
    if not isinstance(entry.get("kind"), str):
        raise DataError(f"Durable entry {entry_id} has no entry kind.")
    model = entry.get("model")
    if model is not None and (not isinstance(model, list) or not all(
            isinstance(message, dict) and isinstance(message.get("role"), str) for message in model)):
        raise DataError(f"Durable entry {entry_id} has an unsupported model message list.")
    data = entry.get("data")
    if data is not None and isinstance(data, dict) and "message" in data and not isinstance(data["message"], dict):
        raise DataError(f"Durable entry {entry_id} carries an unsupported record message.")
    edits = entry.get("edits")
    if edits is not None:
        if not isinstance(edits, list):
            raise DataError(f"Durable entry {entry_id} has an unsupported edit list.")
        for edit in edits:
            if (not isinstance(edit, dict) or not isinstance(edit.get("target"), int)
                    or edit.get("action") not in {"omit", "replace"}):
                raise DataError(f"Durable entry {entry_id} has an unsupported context edit.")
            if edit["action"] == "replace" and not (
                    isinstance(edit.get("messages"), list)
                    and all(isinstance(message, dict) and isinstance(message.get("role"), str)
                            for message in edit["messages"])):
                raise DataError(f"Durable entry {entry_id} replaces context without a message list.")
    return entry


def _identified(message: dict[str, Any], entry: dict[str, Any], index: int) -> dict[str, Any]:
    """The record id the app projection assigns to a model message."""
    data = entry.get("data")
    base = data.get("id") if isinstance(data, dict) and data.get("id") is not None else f"e{entry['id']}"
    return {**message, "id": base if index == 0 else f"{base}#{index}"}


def project_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project durable entries into the record message list, ascending.

    The newest ContextEdit per target wins, an entry that carries edits
    contributes through its target only, markers keep their stored record
    message, and native entries derive ids as `e<entry-id>` (plus `#<index>`
    for every message after the first).
    """
    edits: dict[int, tuple[dict[str, Any], Any, bool]] = {}
    owners = set()
    for entry in entries:
        for edit in entry.get("edits") or []:
            edits[edit["target"]] = (
                entry,
                edit.get("messages") if edit["action"] == "replace" else None,
                edit["action"] == "omit",
            )
            owners.add(entry["id"])
    messages: list[dict[str, Any]] = []
    for entry in entries:
        if entry["kind"] in HIDDEN_KINDS or entry["id"] in owners:
            continue
        edit = edits.get(entry["id"])
        if edit is None:
            data = entry.get("data")
            if isinstance(data, dict) and data.get("message") is not None:
                messages.append(data["message"])
            else:
                messages.extend(_identified(message, entry, index)
                                for index, message in enumerate(entry.get("model") or []))
            continue
        owner, replace, omit = edit
        if omit:
            continue
        owner_data = owner.get("data")
        if isinstance(owner_data, dict) and owner_data.get("message") is not None:
            messages.append(owner_data["message"])
        else:
            messages.extend(_identified(message, owner, index)
                            for index, message in enumerate(replace or []))
    for message in messages:
        if not isinstance(message.get("role"), str):
            raise DataError("A durable entry projects a message without a role; the transcript was not read.")
    return messages


def _validate_schema(database: sqlite3.Connection) -> None:
    tables = {name for (name,) in database.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    missing = {"durable_schema", "conversations", "entries"} - tables
    if missing:
        raise DataError(f"The durable database is not a pi-durable transcript (missing {', '.join(sorted(missing))}).")
    row = database.execute("SELECT version FROM durable_schema WHERE singleton = 1").fetchone()
    if row is None or isinstance(row[0], bool) or not isinstance(row[0], int):
        raise DataError("The durable database has no valid schema version stamp.")
    if row[0] > SCHEMA_VERSION:
        raise DataError(
            f"The durable database uses schema {row[0]}; this reader supports {SCHEMA_VERSION}. "
            "Update the skill; no migration was attempted."
        )
    if row[0] < 1:
        raise DataError(f"The durable database has unsupported schema version {row[0]}.")
    root = database.execute("SELECT record FROM conversations WHERE id = ?", (ROOT_CONVERSATION,)).fetchone()
    try:
        conversation = json.loads(root[0], parse_constant=_reject_constant) if root else None
    except (TypeError, ValueError) as exc:
        raise DataError(f"The root conversation record is not readable JSON: {exc}") from exc
    if not isinstance(conversation, dict) or conversation.get("id") != ROOT_CONVERSATION:
        raise DataError("The durable database has no root conversation for this chat.")


def _read_entries(path: Path, uri: str) -> list[dict[str, Any]]:
    try:
        database = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise DataError(f"Cannot open the durable database {path}: {exc}") from exc
    try:
        _validate_schema(database)
        rows = database.execute(
            "SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id ASC",
            (ROOT_CONVERSATION,),
        ).fetchall()
    except sqlite3.Error as exc:
        raise DataError(f"Cannot read the durable database {path}: {exc}") from exc
    finally:
        database.close()
    return [_entry(row_id, raw) for row_id, raw in rows]


def _read_database(path: Path) -> list[dict[str, Any]]:
    """Read without changing anything in the data folder.

    A WAL database needs its shared-memory file, which SQLite creates or
    rewrites even for a read-only connection. So a database with present WAL
    sidecars is copied, with its WAL, to a temporary directory outside the data
    folder and read there. A checkpointed database is read in place with
    immutable mode, which creates no sidecar files.
    """
    wal = path.with_name(f"{path.name}-wal")
    shm = path.with_name(f"{path.name}-shm")
    try:
        if wal.exists() or shm.exists():
            with tempfile.TemporaryDirectory(prefix="learnharness-read-") as temporary:
                copy = Path(temporary) / path.name
                shutil.copyfile(path, copy)
                if wal.exists():
                    shutil.copyfile(wal, Path(temporary) / wal.name)
                return _read_entries(copy, f"{copy.as_uri()}?mode=ro")
        return _read_entries(path, f"{path.as_uri()}?mode=ro&immutable=1")
    except OSError as exc:
        raise DataError(f"Cannot read the durable database {path}: {exc}") from exc


def read_transcript(root: Path, session_id: str) -> list[dict[str, Any]]:
    """The chat's stored record messages, projected from its durable entries."""
    database = safe_path(root, Path("durable") / session_id / "harness.sqlite")
    relative = database.relative_to(root.resolve())
    for suffix in ("-wal", "-shm"):
        safe_path(root, relative.with_name(database.name + suffix))
    if not database.is_file():
        raise DataError(
            f"Session {session_id} has no durable transcript at {database}. "
            "Its metadata exists, but the database is missing; nothing was created or repaired."
        )
    return project_entries(_read_database(database))
