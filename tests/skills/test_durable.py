"""Format-2 durable transcript tests, including a real pi-durable database.

The database tests run the app's own store module through a test-only Node
fixture, so the input is the pinned library's real schema, not a hand-built
approximation. They skip when Node or the app dependencies are unavailable; the
reader itself stays Python-standard-library only at runtime.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "skills" / "learnharness" / "scripts"
FIXTURE = ROOT / "tests" / "skills" / "durable_fixture.mjs"
TSX = ROOT / "node_modules" / ".bin" / "tsx"
PINNED = ROOT / "node_modules" / "@earendil-works" / "pi-durable" / "package.json"
CHAT = "chat_fixture"
sys.path.insert(0, str(SCRIPTS))
import _data
import _durable

FIXTURE_AVAILABLE = shutil.which("node") is not None and TSX.is_file() and PINNED.is_file()
REQUIRES_FIXTURE = unittest.skipUnless(
    FIXTURE_AVAILABLE, "requires node, tsx, and the pinned pi-durable install for a real database"
)


def entry(entry_id, kind, *, model=None, data=None, edits=None):
    value = {"id": entry_id, "conversationId": 1, "kind": kind}
    if model is not None:
        value["model"] = model
    if data is not None:
        value["data"] = data
    if edits is not None:
        value["edits"] = edits
    return value


def user(text, message_id=None):
    return {"role": "user", "content": text, "timestamp": 1, **({"id": message_id} if message_id else {})}


def snapshot(folder):
    result = {}
    for path in sorted(folder.rglob("*")):
        relative = path.relative_to(folder).as_posix()
        if path.is_dir():
            result[relative] = ("dir",)
        else:
            stat = path.stat()
            result[relative] = ("file", hashlib.sha256(path.read_bytes()).hexdigest(), stat.st_size, stat.st_mtime_ns)
    return result


def run_fixture(data, chat_id, *arguments, stdin=None, timeout=120):
    runner = [str(TSX), str(FIXTURE)] if TSX.is_file() else ["node", str(FIXTURE)]
    return subprocess.run(
        [*runner, str(data), chat_id, *arguments], input=stdin, capture_output=True, text=True,
        timeout=timeout, cwd=ROOT, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def cli(root, *arguments):
    return subprocess.run(
        [sys.executable, "-B", str(SCRIPTS / "sessions.py"), "--data-dir", str(root), *arguments],
        capture_output=True, text=True, timeout=120, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def graph_cli(root, *arguments):
    return subprocess.run(
        [sys.executable, "-B", str(SCRIPTS / "graph.py"), "--data-dir", str(root), *arguments],
        capture_output=True, text=True, timeout=120, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def write_metadata(root, chat_id=CHAT, **changes):
    value = {
        "id": chat_id, "title": "Durable fixture session", "kind": "teach",
        "createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-02T00:00:00.000Z", "version": 2,
    }
    value.update(changes)
    (root / "chats").mkdir(parents=True, exist_ok=True)
    (root / "chats" / f"{chat_id}.json").write_text(json.dumps(value), encoding="utf-8")


class ProjectionTest(unittest.TestCase):
    def test_ids_match_the_app_projection(self):
        entries = [
            entry(8, "lh.user", model=[user("learn joins")], data={"id": "msg_user"}),
            entry(9, "pi.assistant", model=[
                {"role": "assistant", "content": [{"type": "text", "text": "one"}], "timestamp": 2},
                {"role": "assistant", "content": [{"type": "text", "text": "two"}], "timestamp": 3},
            ]),
            entry(10, "lh.marker", data={"message": {"id": "msg_marker", "role": "custom", "customType": "probe-handoff", "content": "x", "display": True, "details": {}}}),
            entry(11, "lh.tool-result", model=[{"role": "toolResult", "toolCallId": "c", "toolName": "read", "content": [], "isError": False}], data={"id": "msg_result"}),
        ]
        messages = _durable.project_entries(entries)
        self.assertEqual([message["id"] for message in messages], ["msg_user", "e9", "e9#1", "msg_marker", "msg_result"])
        self.assertEqual(messages[1]["content"], [{"type": "text", "text": "one"}], "native messages stay verbatim")
        self.assertEqual(messages[1]["timestamp"], 2)

    def test_newest_edit_per_target_wins_and_owner_entries_are_hidden(self):
        target = entry(3, "pi.toolResult", model=[{"role": "toolResult", "toolCallId": "call_q", "toolName": "quiz", "content": [{"type": "text", "text": "pose ack"}], "details": None, "isError": False}])
        entries = [
            target,
            entry(4, "lh.edit", data={"id": "msg_old"}, edits=[{"target": 3, "action": "replace", "messages": [user("old answer")]}]),
            entry(5, "lh.edit", data={"id": "msg_new"}, edits=[{"target": 3, "action": "replace", "messages": [user("new answer")]}]),
            entry(6, "lh.marker", data={"message": {"id": "msg_marker", "role": "custom", "customType": "practice-thinking", "content": "x", "display": True, "details": {}}}),
            entry(7, "lh.edit", data={"message": {"id": "msg_marker_new", "role": "custom", "customType": "practice-thinking", "content": "replaced", "display": True, "details": {}}}, edits=[{"target": 6, "action": "replace", "messages": []}]),
            entry(8, "lh.edit", data={"id": "msg_omit"}, edits=[{"target": 3, "action": "omit"}]),
        ]
        messages = _durable.project_entries(entries)
        self.assertEqual([message["id"] for message in messages], ["msg_marker_new"])
        self.assertEqual(messages[0]["content"], "replaced")
        # A visible edit owner never contributes its own model input.
        self.assertTrue(all(message["id"] != "msg_omit" for message in messages))

        entries[-1:] = []
        messages = _durable.project_entries(entries)
        self.assertEqual([message["id"] for message in messages], ["msg_new", "msg_marker_new"])
        self.assertEqual(messages[0]["content"], "new answer")

    def test_bookkeeping_entries_are_hidden(self):
        entries = [
            entry(1, "lh.continuation", model=[user("[continue]")]),
            entry(2, "pi.system", model=[{"role": "system", "content": [], "timestamp": 0}]),
            entry(3, "pi.compaction", model=[user("summary of earlier teaching")]),
            entry(4, "lh.marker", data={"message": {"id": "m", "role": "custom", "customType": "subagent-abort", "content": "aborted", "display": True, "details": {}}}),
        ]
        self.assertEqual([message["id"] for message in _durable.project_entries(entries)], ["e3", "m"])

    def test_malformed_entries_are_refused_at_the_boundary(self):
        for value in (
            entry(1, "lh.user", model=[{"content": "no role"}]),
            entry(1, "bad", edits=[{"target": 1, "action": "replace"}]),
            dict(entry(1, "lh.user"), id=2),
        ):
            with self.subTest(value=value), self.assertRaises(_data.DataError):
                _durable.project_entries([_durable._entry(1, json.dumps(value))])


@REQUIRES_FIXTURE
class DurableDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.data = Path(cls.temporary.name) / "data"
        built = run_fixture(cls.data, CHAT, "build")
        if built.returncode != 0:
            raise unittest.SkipTest(f"durable fixture failed: {built.stderr[-800:]}")
        cls.expected = json.loads(built.stdout)["expected"]

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_record_shape_and_exact_projection(self):
        record = _data.read_chat(self.data, CHAT)
        self.assertEqual(record["id"], CHAT)
        self.assertEqual(record["title"], "Durable fixture session")
        self.assertEqual(record["version"], 2)
        self.assertEqual(record["kind"], "teach")
        self.assertEqual(record["messages"], self.expected)
        metadata = _data.read_chat_meta(self.data, CHAT)
        self.assertNotIn("messages", metadata)
        ids = [message["id"] for message in record["messages"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(any(message_id.startswith("e") and "#" not in message_id for message_id in ids), "derived native id")

    def test_cli_read_preserves_answers_and_does_not_present_a_pose_as_an_answer(self):
        response = cli(self.data, "--format", "json", "read", CHAT)
        self.assertEqual(response.returncode, 0, response.stderr)
        selected = json.loads(response.stdout)["record"]
        self.assertEqual([message["id"] for message in selected["messages"]], [message["id"] for message in self.expected])
        text = cli(self.data, "read", CHAT)
        self.assertEqual(text.returncode, 0, text.stderr)
        output = text.stdout
        for phrase in ("A join combines rows from two tables.", "Native reply without a stamped id.",
                       "learner reasoning", "Learner answer snapshot", "msg_context_1", "late committed turn"):
            self.assertIn(phrase, output)
        full = cli(self.data, "read", CHAT, "--include-operations")
        self.assertEqual(full.returncode, 0, full.stderr)
        self.assertIn("native tool output", full.stdout)
        self.assertIn("injected graph context", full.stdout)
        self.assertEqual(output.count("### Question posed — no learner answer recorded"), 1)
        self.assertEqual(output.count("### Learner answer snapshot"), 1)
        self.assertIn("call_probe_2", output)
        for hidden in ("[continue]", "Stored role: system", "old practice trace"):
            self.assertNotIn(hidden, output)

    def test_list_and_graph_labels_need_only_metadata(self):
        listed = cli(self.data, "--format", "json", "list")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual([session["id"] for session in json.loads(listed.stdout)["sessions"]], [CHAT])

        (self.data / "graph").mkdir(exist_ok=True)
        answer_id = next(message["id"] for message in self.expected if message.get("toolName") == "quiz")
        (self.data / "graph" / "nodes.jsonl").write_text(json.dumps({
            "id": "n_join", "name": "Join", "statement": "A join combines rows.", "aliases": [],
            "createdAt": "2026-11-01T00:00:00.000Z", "provenance": [{"chatId": CHAT, "messageId": answer_id}],
        }) + "\n", encoding="utf-8")
        (self.data / "graph" / "chains.jsonl").write_text("", encoding="utf-8")
        sessions = graph_cli(self.data, "--format", "json", "sessions")
        self.assertEqual(sessions.returncode, 0, sessions.stderr)
        record = json.loads(sessions.stdout)["records"][0]
        self.assertEqual(record["name"], "Durable fixture session")
        self.assertEqual(record["kind"], "chat")
        self.assertEqual(record["propositions"], 1)
        propositions = graph_cli(self.data, "--format", "json", "propositions", "--session", CHAT)
        self.assertEqual(propositions.returncode, 0, propositions.stderr)
        self.assertEqual([item["id"] for item in json.loads(propositions.stdout)["records"]], ["n_join"])

        # The transcript database is not needed for metadata or graph labels.
        database = self.data / "durable" / CHAT / "harness.sqlite"
        moved = database.with_suffix(".moved")
        database.rename(moved)
        try:
            self.assertEqual(cli(self.data, "--format", "json", "list").returncode, 0)
            self.assertEqual(graph_cli(self.data, "--format", "json", "sessions").returncode, 0)
            missing = cli(self.data, "read", CHAT)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("no durable transcript", missing.stderr)
            self.assertNotIn("Traceback", missing.stderr)
        finally:
            moved.rename(database)

    def test_reads_create_and_change_no_files(self):
        before = snapshot(self.data)
        for arguments in (("--format", "json", "list"), ("--format", "json", "read", CHAT),
                          ("read", CHAT), ("read", CHAT, "--include-agent-thinking", "--include-operations")):
            response = cli(self.data, *arguments)
            self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(graph_cli(self.data, "--format", "json", "sessions").returncode, 0)
        self.assertEqual(snapshot(self.data), before)

    def test_v2_metadata_messages_are_not_the_current_transcript(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            shutil.copytree(self.data / "durable", root / "durable")
            write_metadata(root, messages=[{"id": "stale", "role": "user", "content": "stale pre-migration copy"}])
            self.assertEqual(_data.read_chat(root, CHAT)["messages"], self.expected)
            self.assertNotIn("stale pre-migration copy", cli(root, "read", CHAT).stdout)


@REQUIRES_FIXTURE
class DurableWalTest(unittest.TestCase):
    def test_live_wal_committed_turns_are_read_without_touching_the_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            runner = [str(TSX), str(FIXTURE)] if TSX.is_file() else ["node", str(FIXTURE)]
            process = subprocess.Popen(
                [*runner, str(root), CHAT, "wal"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, cwd=ROOT,
            )
            def stop():
                if process.poll() is None:
                    process.kill()
                    process.wait()
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()
            self.addCleanup(stop)
            line = process.stdout.readline()
            if not line:
                self.fail(f"durable fixture produced no ready line: {process.stderr.read()[-800:]}")
            ready = json.loads(line)
            self.assertTrue(ready["ready"])
            files = root / "durable" / CHAT
            self.assertEqual(sorted(path.name for path in files.iterdir()),
                             ["harness.sqlite", "harness.sqlite-shm", "harness.sqlite-wal"])

            before = snapshot(files)
            record = _data.read_chat(root, CHAT)
            self.assertEqual(record["messages"], ready["expected"])
            self.assertEqual(snapshot(files), before, "reading live WAL data changed no data-folder file")

            process.stdin.write("append\n")
            process.stdin.flush()
            appended = json.loads(process.stdout.readline())
            self.assertTrue(appended["appended"])
            self.assertNotEqual(appended["expected"], ready["expected"])
            before = snapshot(files)
            self.assertEqual(_data.read_chat(root, CHAT)["messages"], appended["expected"])
            self.assertEqual(snapshot(files), before)

            process.stdin.write("close\n")
            process.stdin.flush()
            self.assertEqual(process.wait(timeout=60), 0, f"fixture exit: {process.stderr.read()[-800:]}")
            before = snapshot(files)
            self.assertEqual(_data.read_chat(root, CHAT)["messages"], appended["expected"])
            self.assertEqual(snapshot(files), before)


class DurableFailureTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "data"
        write_metadata(self.root)

    def test_missing_corrupt_and_incompatible_databases_are_explicit(self):
        with self.assertRaisesRegex(_data.DataError, "no durable transcript"):
            _data.read_chat(self.root, CHAT)

        database = self.root / "durable" / CHAT / "harness.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"not a sqlite database")
        response = cli(self.root, "read", CHAT)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("durable database", response.stderr)
        self.assertNotIn("Traceback", response.stderr)

        for version, tables, message in (
            (3, True, "Update the skill"),
            (2, False, "not a pi-durable transcript"),
        ):
            with self.subTest(version=version, tables=tables):
                database.unlink()
                connection = sqlite3.connect(database)
                connection.execute("CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)")
                connection.execute("INSERT INTO durable_schema VALUES (1, ?)", (version,))
                if tables:
                    connection.execute("CREATE TABLE conversations (id INTEGER PRIMARY KEY, record TEXT NOT NULL)")
                    connection.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)")
                    connection.execute("INSERT INTO conversations VALUES (1, '{\"id\":1}')")
                connection.commit()
                connection.close()
                with self.assertRaisesRegex(_data.DataError, message):
                    _data.read_chat(self.root, CHAT)

    def test_symlinked_durable_directory_cannot_escape_the_data_folder(self):
        outside = Path(self.temporary.name) / "outside"
        (outside / "durable").mkdir(parents=True)
        try:
            (self.root / "durable").symlink_to(outside / "durable")
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks are unavailable")
        with self.assertRaisesRegex(_data.DataError, "outside"):
            _data.read_chat(self.root, CHAT)
        response = cli(self.root, "read", CHAT)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("outside", response.stderr)

    def test_invalid_metadata_shapes_are_refused(self):
        for changes, message in (
            ({"version": 3}, "Update the skill"),
            ({"version": True}, "invalid version"),
            ({"version": 1.5}, "invalid version"),
            ({"title": 7}, "title/date"),
            ({"id": "someone_else"}, "mismatch"),
        ):
            with self.subTest(changes=changes):
                write_metadata(self.root, **changes)
                with self.assertRaisesRegex(_data.DataError, message):
                    _data.read_chat(self.root, CHAT)


if __name__ == "__main__":
    unittest.main()
