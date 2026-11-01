#!/usr/bin/env python3
"""Kosmos status line for Claude Code.

Port of the two Pi extensions in pi/agent/extensions/:

  footer.ts          the cwd (branch) line and the stats line with the model on
                     the right
  agent-name-hint.ts the active persona, taken from the first heading of the
                     agent's prompt

Claude Code runs this on every update and pipes the session JSON to stdin
(https://code.claude.com/docs/en/statusline). The output is three lines:

  ~/Dotfiles (main) • my-session
  $0.048 +$0.015 █░░░░░░░░░░░ 8.0%/200k              claude-sonnet-5-5 • xhigh
  ● kosmos-orchestrator

The stats line carries two cost segments: the orchestrator's own cost in the
accent purple, and the total spent by the delegated subagents in the success
green, prefixed with a plain "+". Claude Code's cost.total_cost_usd includes
the subagents' spend, so the two segments add up to the reported total.

The split is computed from the transcripts. The parent conversation is
`transcript_path` from the session JSON; the subagents write their own
transcripts to `agent-*.jsonl` in the `subagents/` directory of the session
next to it, with `isSidechain: true` entries. A transcript carries no cost
per message, so the tokens are priced with Anthropic's standard ratios
(output = 5x input, cache read = 0.1x, cache write 5m = 1.25x, cache write
1h = 2x) into weighted token units, and the units of both sides are scaled to
the reported total. That keeps the split correct for any model id without a
price table of its own.

The request ids are deduplicated per side, not per file. An id that the
parent's transcript carries in a non-sidechain entry belongs to the
orchestrator and is counted as the orchestrator's, even when a subagent's
transcript carries the same id. An id that appears in a sidechain entry of the
parent or in a subagent's transcript belongs to the subagents, and is counted
once. The parent's own copy always wins, so the split does not depend on
which file was read first.

Edge case: when the total cost is zero or missing, or the transcripts cannot
be read, the split is not computed at all and only the single cost segment is
shown. No number is ever invented.

The transcripts grow to hundreds of KB and this runs on every message, so
they are parsed incrementally: the byte offset already consumed and the
running weights are cached per file (in memory and, since every run is a
fresh process, under ~/.cache) and only the new bytes are parsed.

A message is never counted twice, and the two paths of an unterminated tail
differ. When the buffer holds at least one newline, the complete lines are
counted and the bytes after the last newline stay unconsumed -- the offset
points at them -- so they are read again on the next run, but they have not
been counted yet. When the buffer holds no newline at all, the whole tail is
kept pending and not one of its bytes is consumed, so nothing of it is read
again. A tail that grows past the pending cap loses its oldest bytes: those
bytes cannot be parsed any more, so the file's weight is an undercount and
is marked as inexact. The split is then not shown for that session at all,
rather than a silently wrong one.

The cache lives in ~/.cache/kosmos-statusline: the directory is 0700 and the
cache file 0600, because it holds the absolute paths of every transcript
that was opened and the request ids of the session. At most 1 MiB are read
from one transcript per invocation and at most 9 MiB from all of them (the
parent plus at most eight subagents), so a status line cannot stall on a
large transcript. Only a regular file is read at all: the file is opened with
O_NOFOLLOW and O_NONBLOCK and is checked with fstat on the descriptor, so a
path that was swapped for a fifo cannot block the render. A transcript line that cannot be parsed (a
truncated one, or one nested deeply enough to raise a RecursionError) is
skipped: the status line keeps rendering and the offset moves past the line,
so the file is not parsed again on the next run. Two status lines that run at
the same time do not overwrite each other: the cache is merged under an
exclusive lock, the offsets keep the largest value and the deduplicated
request ids are unioned.

Preview without launching Claude Code:

  echo '{"agent":{"name":"kosmos-orchestrator"},"model":{"id":"claude-sonnet-5-5"}}' \\
    | COLUMNS=80 python3 claude/statusline.py

Colours are the Pi theme's palette (claude/themes/kosmos.json). NO_COLOR turns
them off.
"""
import base64
import fcntl
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

ACCENT = (168, 85, 247)  # purple: the persona dot and the orchestrator's cost
GREEN = (74, 222, 128)  # green: the delegated subagents' cost
DIM = (216, 180, 254)  # purplePastel: the footer's "dim"
MUTED = (161, 161, 170)  # gray: the bar's empty cells
WARNING = (250, 204, 21)
ERROR = (248, 113, 113)

# Claude Code indents the status line by two columns; leave the same on the
# right so the model on line 2 is not cut off with an ellipsis.
MARGIN = 4
MIN_PADDING = 2
FALLBACK_PERSONA = "Claude Code"

# Context usage bar: cell characters, default width and the degradation ladder.
BAR_FILLED = "█"
BAR_EMPTY = "░"
BAR_WIDTHS = (12, 8, 6, 4)

# A percentage above 100 % is possible (the estimate can exceed the window),
# so the ceiling is generous; beyond it the number is not a percentage.
MAX_CONTEXT_PERCENT = 1000

ANSI = re.compile(r"\033\[[0-9;]*m")

# Anthropic's standard price ratios, used to price tokens without a per-model
# table: the user's model ids are not standard, but the ratios are the same
# across Anthropic's current lineup.
OUTPUT_RATIO = 5.0
CACHE_WRITE_5M_RATIO = 1.25
CACHE_WRITE_1H_RATIO = 2.0
CACHE_READ_RATIO = 0.1

# The transcript cache: per file the byte offset already consumed, the running
# token weights and the requests already counted with their weight, and per
# session the deduplicated request ids of the orchestrator and of its
# subagents. It lives on disk as well, because every status line run is a
# fresh process.
CACHE_DIR_NAME = "kosmos-statusline"
CACHE_FILE_NAME = "transcripts.json"
LOCK_FILE_NAME = "transcripts.lock"
CACHE_VERSION = 4
MAX_CACHED_FILES = 64
# The deduplication only has to cover the recent streaming-duplicate window.
MAX_SEEN_KEYS = 512
# The request ids a file contributed, kept so that a re-read file can drop
# them from the session's deduplication set. The bound is the same as the
# session's own, and it is applied per side (the session's sets are per
# side as well): an id that is still in one of the session's sets has to be
# in the file's map too, otherwise the re-read of the file skips the
# message as a duplicate and the file silently loses its weight.
MAX_FILE_IDS = MAX_SEEN_KEYS
# The subagent transcripts summed per run. The split is approximate anyway,
# so an unbounded number of them is not worth the time.
MAX_CHILD_TRANSCRIPTS = 8
# At most this many bytes are read from one transcript per invocation.
MAX_READ_BYTES = 1024 * 1024
# At most this many bytes are read from all the transcripts of one
# invocation: the parent plus the subagents.
MAX_RUN_READ_BYTES = (MAX_CHILD_TRANSCRIPTS + 1) * MAX_READ_BYTES
# At most this many bytes of an unterminated last line are kept.
MAX_PENDING_BYTES = 1024 * 1024

_TRANSCRIPT_CACHE = None
_TRANSCRIPT_DIRTY = False
# What is left of the per-invocation read budget. It is decremented by the
# bytes actually read, so one status line cannot read dozens of megabytes.
_READ_BUDGET = MAX_RUN_READ_BYTES


def paint(rgb, text):
    # A None colour paints nothing: the "+" in front of the subagent cost
    # stays plain.
    if rgb is None or os.environ.get("NO_COLOR") or not text:
        return text
    return "\033[38;2;%d;%d;%dm%s\033[39m" % (rgb + (text,))


def visible_width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in ANSI.sub("", text))


def finite_number(value):
    """The value as a finite float, or None when it is not a finite number.

    A bool is an int subclass, so it is rejected on purpose; strings, None,
    NaN and both infinities are rejected as well. A huge integer is
    converted defensively: float() and math.isfinite() raise on it.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    return number if math.isfinite(number) else None


def token_weight(usage):
    """The weighted token units of one message usage object.

    The weights are Anthropic's price ratios, so the units are proportional to
    the money the message cost: output is 5x an input token, a cache read is
    0.1x, a 5 minute cache write 1.25x and a 1 hour cache write 2x. The 5
    minute / 1 hour breakdown is preferred, but only when it carries a count:
    an empty breakdown falls back to the whole cache_creation_input_tokens
    count, which is treated as a 5 minute write.
    """
    if not isinstance(usage, dict):
        return 0.0
    input_tokens = finite_number(usage.get("input_tokens")) or 0.0
    output_tokens = finite_number(usage.get("output_tokens")) or 0.0
    cache_read = finite_number(usage.get("cache_read_input_tokens")) or 0.0
    # The fallback first: a breakdown without a count must not throw the
    # cache write away.
    write_5m = finite_number(usage.get("cache_creation_input_tokens")) or 0.0
    write_1h = 0.0
    breakdown = usage.get("cache_creation")
    if isinstance(breakdown, dict):
        breakdown_5m = finite_number(breakdown.get("ephemeral_5m_input_tokens")) or 0.0
        breakdown_1h = finite_number(breakdown.get("ephemeral_1h_input_tokens")) or 0.0
        if breakdown_5m + breakdown_1h > 0:
            write_5m = breakdown_5m
            write_1h = breakdown_1h
    return (
        input_tokens
        + OUTPUT_RATIO * output_tokens
        + CACHE_WRITE_5M_RATIO * write_5m
        + CACHE_WRITE_1H_RATIO * write_1h
        + CACHE_READ_RATIO * cache_read
    )


def cache_file():
    """The path of the on-disk transcript cache."""
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, CACHE_DIR_NAME, CACHE_FILE_NAME)


def _seen_set(keys):
    """The seen request ids as an ordered set.

    A dict keeps the insertion order, so the oldest ids are the ones at the
    front and are the ones dropped when the set is trimmed.
    """
    seen = {}
    if isinstance(keys, (list, tuple)):
        for key in keys:
            if isinstance(key, str) and key:
                seen[key] = True
    return seen


def _trim_seen(seen):
    """Keep the seen ids within their bound, dropping the oldest ones."""
    while len(seen) > MAX_SEEN_KEYS:
        del seen[next(iter(seen))]


def _read_cache_file(path):
    """The cache file as parsed JSON, or None when it cannot be read.

    Every failure is swallowed: the cache is a pure optimisation and must
    never break the render, not even with a deeply nested file that raises
    a RecursionError.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _new_session():
    """An empty session: the request ids of each side.

    The two sides are kept apart, so the parent's own copy of a request id
    can be told apart from the copy in a subagent's transcript.
    """
    return {"main_ids": {}, "side_ids": {}}


def _new_file_entry(session_key):
    """An empty cache entry for one file."""
    return {
        "size": 0,
        "mtime_ns": 0,
        "offset": 0,
        "w_main": 0.0,
        "w_side": 0.0,
        "session": session_key,
        "pending": b"",
        "used": 0.0,
        "idw": {},
        "reset": False,
        "poisoned": False,
        "dropped": 0,
    }


def _reset_file_entry(entry):
    """Forget everything a file was parsed into, so it is read again."""
    entry["offset"] = 0
    entry["pending"] = b""
    entry["w_main"] = 0.0
    entry["w_side"] = 0.0
    entry["idw"] = {}
    entry["reset"] = False
    entry["poisoned"] = False
    entry["dropped"] = 0


def _trim_idw(entry):
    """Keep the per-id bookkeeping of a file within its bound.

    The bound is per side, like the session's deduplication sets: a file can
    have that many ids on each side that are still deduplicated, and all of
    them have to be forgettable when the file is read again.
    """
    idw = entry.get("idw") or {}
    main = []
    side = []
    for request, info in idw.items():
        if info.get("s") == "main":
            main.append(request)
        else:
            side.append(request)
    for extra in range(len(main) - MAX_FILE_IDS):
        del idw[main[extra]]
    for extra in range(len(side) - MAX_FILE_IDS):
        del idw[side[extra]]


def _parse_idw(raw):
    """The per-id bookkeeping of a file as it is stored in the cache."""
    idw = {}
    if isinstance(raw, dict):
        for request, info in raw.items():
            if not isinstance(request, str) or not request or not isinstance(info, dict):
                continue
            weight = finite_number(info.get("w"))
            if weight is None:
                continue
            field = info.get("f")
            if field not in ("w_main", "w_side"):
                field = "w_main"
            side = info.get("s")
            if side not in ("main", "side"):
                side = "side"
            idw[request] = {"w": weight, "f": field, "s": side}
    return idw


def _file_entry(entry):
    """A validated cache entry for one file, or None when it is unusable."""
    try:
        size = int(entry.get("size") or 0)
        mtime_ns = int(entry.get("mtime_ns") or 0)
        offset = int(entry.get("offset") or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    if size < 0 or mtime_ns < 0 or offset < 0:
        return None
    w_main = finite_number(entry.get("w_main"))
    w_side = finite_number(entry.get("w_side"))
    # A weight that is not finite means the file was miscounted. The entry
    # is kept, but it is marked for a re-read: dropping it would lose the
    # file's contribution, because the session's deduplication would
    # suppress the messages it carries.
    reset = w_main is None or w_side is None
    if reset:
        w_main = 0.0
        w_side = 0.0
    session = entry.get("session")
    pending = entry.get("pending")
    try:
        pending_bytes = base64.b64decode(pending, validate=True) if isinstance(pending, str) else b""
    except Exception:
        pending_bytes = b""
    used = finite_number(entry.get("used")) or 0.0
    idw = _parse_idw(entry.get("idw"))
    try:
        dropped = int(entry.get("dropped") or 0)
    except (TypeError, ValueError, OverflowError):
        dropped = 0
    parsed = {
        "size": size,
        "mtime_ns": mtime_ns,
        "offset": offset,
        "w_main": w_main,
        "w_side": w_side,
        "session": session if isinstance(session, str) else "",
        "pending": pending_bytes,
        "used": used,
        "idw": idw,
        "reset": reset,
        "poisoned": bool(entry.get("poisoned")),
        "dropped": max(0, dropped),
    }
    _trim_idw(parsed)
    return parsed


def load_transcript_cache():
    """Load the transcript cache once; a broken cache is simply ignored."""
    global _TRANSCRIPT_CACHE
    if _TRANSCRIPT_CACHE is not None:
        return _TRANSCRIPT_CACHE
    _TRANSCRIPT_CACHE = {"files": {}, "sessions": {}}
    data = _read_cache_file(cache_file())
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
        # A cache of another version is not understood: it is ignored, so
        # the files are read again from the start.
        return _TRANSCRIPT_CACHE
    files = data.get("files")
    if isinstance(files, dict):
        for path, entry in files.items():
            if not isinstance(path, str) or not isinstance(entry, dict):
                continue
            parsed = _file_entry(entry)
            if parsed is not None:
                _TRANSCRIPT_CACHE["files"][path] = parsed
    sessions = data.get("sessions")
    if isinstance(sessions, dict):
        for key, entry in sessions.items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                continue
            session = _new_session()
            session["main_ids"] = _seen_set(entry.get("main"))
            session["side_ids"] = _seen_set(entry.get("side"))
            _trim_seen(session["main_ids"])
            _trim_seen(session["side_ids"])
            _TRANSCRIPT_CACHE["sessions"][key] = session
    return _TRANSCRIPT_CACHE


def _merge_file_entry(current, incoming):
    """Two observations of the same file, merged into the newer one.

    The offset and the pending tail come from the observation that read
    further; the weights are the larger ones, because both processes read
    the same bytes and counted them the same way.
    """
    base = dict(incoming if incoming["offset"] >= current["offset"] else current)
    base["w_main"] = max(current["w_main"], incoming["w_main"])
    base["w_side"] = max(current["w_side"], incoming["w_side"])
    base["size"] = max(current["size"], incoming["size"])
    base["mtime_ns"] = max(current["mtime_ns"], incoming["mtime_ns"])
    base["used"] = max(current["used"], incoming["used"])
    base["poisoned"] = bool(current.get("poisoned")) or bool(incoming.get("poisoned"))
    base["dropped"] = max(current.get("dropped", 0), incoming.get("dropped", 0))
    idw = dict(current.get("idw") or {})
    for request, info in (incoming.get("idw") or {}).items():
        idw.setdefault(request, info)
    base["idw"] = idw
    _trim_idw(base)
    return base


def _merge_cache(disk, memory):
    """The cache on disk merged with the one of this run.

    Two status lines that run at the same time both load the cache, parse
    their own files and write the whole map back. Without a merge the last
    writer wins and discards the other's offsets and request ids, which
    makes the next run read the same bytes again.
    """
    merged = {"version": CACHE_VERSION, "files": {}, "sessions": {}}
    same_version = isinstance(disk, dict) and disk.get("version") == CACHE_VERSION
    disk_files = disk.get("files") if same_version else None
    if isinstance(disk_files, dict):
        for path, entry in disk_files.items():
            if not isinstance(path, str) or not isinstance(entry, dict):
                continue
            parsed = _file_entry(entry)
            if parsed is not None:
                merged["files"][path] = parsed
    for path, entry in memory["files"].items():
        current = merged["files"].get(path)
        merged["files"][path] = _merge_file_entry(current, entry) if current else dict(entry)
    disk_sessions = disk.get("sessions") if same_version else None
    if isinstance(disk_sessions, dict):
        for key, entry in disk_sessions.items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                continue
            session = _new_session()
            session["main_ids"] = _seen_set(entry.get("main"))
            session["side_ids"] = _seen_set(entry.get("side"))
            _trim_seen(session["main_ids"])
            _trim_seen(session["side_ids"])
            merged["sessions"][key] = session
    for key, entry in memory["sessions"].items():
        target = merged["sessions"].setdefault(key, _new_session())
        for request in entry["main_ids"]:
            target["main_ids"][request] = True
        for request in entry["side_ids"]:
            target["side_ids"][request] = True
        _trim_seen(target["main_ids"])
        _trim_seen(target["side_ids"])
    # The files that were consumed last are kept; the others are dropped.
    kept = sorted(merged["files"].items(), key=lambda item: item[1]["used"], reverse=True)
    kept = kept[:MAX_CACHED_FILES]
    kept_files = dict(kept)
    # A dropped file is read from the start again, so its requests have to
    # be forgotten: the deduplication set of its session would drop them as
    # duplicates and the file would end up with no weight at all.
    for path, entry in merged["files"].items():
        if path not in kept_files:
            _forget_ids(kept_files, merged["sessions"], entry.get("session"), entry)
    merged["files"] = kept_files
    live = set(entry.get("session") for _, entry in kept)
    merged["sessions"] = {
        key: entry for key, entry in merged["sessions"].items() if key in live
    }
    return merged


def _serialise_cache(data):
    """The cache as plain JSON: the pending tail is base64 encoded."""
    files = {}
    for path, entry in data["files"].items():
        files[path] = {
            "size": entry["size"],
            "mtime_ns": entry["mtime_ns"],
            "offset": entry["offset"],
            "w_main": entry["w_main"],
            "w_side": entry["w_side"],
            "session": entry.get("session", ""),
            "used": entry.get("used", 0.0),
            "idw": dict(entry.get("idw") or {}),
            "reset": bool(entry.get("reset")),
            "poisoned": bool(entry.get("poisoned")),
            "dropped": int(entry.get("dropped") or 0),
            "pending": base64.b64encode(entry.get("pending") or b"").decode("ascii"),
        }
    sessions = {
        key: {"main": list(entry["main_ids"]), "side": list(entry["side_ids"])}
        for key, entry in data["sessions"].items()
    }
    return {"version": CACHE_VERSION, "files": files, "sessions": sessions}


def _write_cache(path, data):
    """Write the cache file atomically, with 0600 permissions."""
    directory = os.path.dirname(path)
    # A temporary file with a predictable name in a group writable
    # directory would be an arbitrary file overwrite, so it is created
    # exclusively and moved into place.
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".transcripts-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(_serialise_cache(data), stream)
        os.chmod(temporary, 0o600)
        # The rename is atomic, so a concurrent run never sees a half-written
        # cache.
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def save_transcript_cache():
    """Write the cache back; a cache that cannot be written is not an error.

    The write is a merge under an exclusive lock: a concurrent run that
    parsed more of a transcript does not lose its offsets and request ids.
    """
    if not _TRANSCRIPT_DIRTY or not _TRANSCRIPT_CACHE:
        # Nothing was read: the cache directory and the lock file are not
        # created for a run that has nothing to save.
        return
    path = cache_file()
    directory = os.path.dirname(path)
    lock_path = os.path.join(directory, LOCK_FILE_NAME)
    try:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    except OSError:
        return
    try:
        # An older version created the directory with the umask, which can
        # leave it group or world readable.
        if os.stat(directory).st_mode & 0o077:
            os.chmod(directory, 0o700)
    except OSError:
        pass
    try:
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return
    try:
        with os.fdopen(lock_fd, "r+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                data = _merge_cache(_read_cache_file(path), _TRANSCRIPT_CACHE)
                _write_cache(path, data)
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except (OSError, ValueError, TypeError):
        pass


def _reassign_to_main(cache, session, key):
    """Move a request id from the subagent side to the orchestrator side.

    The id was counted in a subagent's transcript, or as a sidechain entry
    of the parent, before the parent's own copy of it appeared. The
    contribution of the subagent copy is taken back, so the id is counted
    exactly once, on the orchestrator side.
    """
    for other in cache["files"].values():
        idw = other.get("idw") or {}
        info = idw.get(key)
        if not info or info.get("s") != "side":
            continue
        field = info.get("f")
        if field not in ("w_main", "w_side"):
            field = "w_main"
        other[field] = max(0.0, other.get(field, 0.0) - info.get("w", 0.0))
        del idw[key]
    session["side_ids"].pop(key, None)


def consume_line(entry, line, session, is_parent, cache):
    """Fold one transcript line into the running weights.

    The request ids are deduplicated per side: `session["main_ids"]` holds
    the ids the orchestrator owns and `session["side_ids"]` the ones the
    subagents own. An id that the parent's transcript carries in a
    non-sidechain entry belongs to the orchestrator, even when a subagent's
    transcript carries the same id; an id that appears in a sidechain entry
    or in a child's transcript belongs to the subagents. The parent's own
    copy always wins, so the split does not depend on which file was read
    first.

    A transcript is untrusted input: a line that cannot be parsed (a
    truncated one, or one nested deeply enough to raise a RecursionError)
    is skipped, but it must not take the status line down with it.
    """
    if not line or b'"usage"' not in line:
        return
    try:
        record = json.loads(line)
    except Exception:
        # A poisoned line is not counted, but the offset still moves past
        # it, so the file is not parsed again on the next run.
        return
    if not isinstance(record, dict) or record.get("type") != "assistant":
        return
    message = record.get("message")
    usage = message.get("usage") if isinstance(message, dict) else None
    if not isinstance(usage, dict):
        return
    weight = token_weight(usage)
    if not math.isfinite(weight):
        # A weight that overflows is not counted: it would poison the
        # running sum of the file with an infinity.
        return
    # The same request is written to the transcript more than once while it
    # streams, so the requests are counted once, by request id when there is
    # one and by message uuid otherwise.
    key = record.get("requestId") or record.get("uuid")
    if not isinstance(key, str) or not key:
        key = None
    idw = entry.setdefault("idw", {})
    if is_parent and not record.get("isSidechain"):
        # The orchestrator's own message.
        if key is not None:
            if key in session["main_ids"]:
                return
            if key in session["side_ids"]:
                # The id was counted on the subagent side before the
                # parent's copy appeared: the contribution of the subagent
                # copy is taken back and the id counts once, here.
                _reassign_to_main(cache, session, key)
            session["main_ids"][key] = True
        if not _add_weight(entry, "w_main", weight):
            return
        if key is not None:
            idw[key] = {"w": weight, "f": "w_main", "s": "main"}
            _trim_idw(entry)
        return
    # A sidechain entry of the parent, or a message of a subagent.
    if key is not None:
        if key in session["main_ids"]:
            # The parent owns this id: the copy on the subagent side is
            # dropped.
            return
        if key in session["side_ids"]:
            return
        session["side_ids"][key] = True
    field = "w_side" if is_parent else "w_main"
    if not _add_weight(entry, field, weight):
        return
    if key is not None:
        idw[key] = {"w": weight, "f": field, "s": "side"}
        _trim_idw(entry)


def _add_weight(entry, field, weight):
    """Add a weight to a running sum, or mark the file as poisoned.

    A sum that overflowed is not a weight: the file's numbers cannot be
    trusted any more, so the file is marked and the split is not computed
    for the session. The sum itself stays finite, so the cache does not
    have to be thrown away on the next run.
    """
    total = entry.get(field, 0.0) + weight
    if not math.isfinite(total):
        entry["poisoned"] = True
        return False
    entry[field] = total
    return True


def _forget_ids(files, sessions, session_key, entry):
    """Drop the request ids of a re-read file from the session's sets.

    A transcript that was rewritten is read from the start again, so the
    requests it carried have to be counted again. The deduplication sets
    belong to the session, so the ids of the file are removed from them --
    but only the ones no other file of the session carries.
    """
    others = set()
    for other in files.values():
        if other is not entry:
            others.update(other.get("idw") or {})
    session = sessions.get(session_key)
    if not session:
        return
    for request, info in (entry.get("idw") or {}).items():
        if request in others:
            continue
        if info.get("s") == "main":
            session["main_ids"].pop(request, None)
        else:
            session["side_ids"].pop(request, None)


def _read_bytes(fd, start):
    """Read the allowed number of bytes from an open transcript.

    The per-invocation budget is what keeps a status line from reading
    dozens of megabytes: it is decremented by the bytes that are actually
    read, and no file is read at all once it is exhausted.
    """
    global _READ_BUDGET
    allowance = min(MAX_READ_BYTES, _READ_BUDGET)
    if allowance <= 0:
        return b""
    try:
        os.lseek(fd, start, os.SEEK_SET)
    except OSError:
        return b""
    chunks = []
    while allowance > 0:
        try:
            chunk = os.read(fd, allowance)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
        allowance -= len(chunk)
    data = b"".join(chunks)
    _READ_BUDGET -= len(data)
    return data


def parse_transcript(path, session_key, is_parent):
    """The (main, sidechain) token weights of a transcript.

    Only the bytes that were not read yet are parsed: the cache holds the
    offset already consumed and the running weights. A file that shrank was
    rotated or truncated, so its entry is dropped and the file is read from
    the start again. A partially written last line is kept unconsumed in the
    cache until the rest of it arrives, so it is not read twice.

    The file is opened with O_NOFOLLOW and O_NONBLOCK and is checked with
    fstat on the descriptor itself, so a path that was swapped for a fifo
    between the check and the open cannot block the status line. Only a
    regular file is read, and at most MAX_READ_BYTES of it per invocation.
    """
    global _TRANSCRIPT_DIRTY
    cache = load_transcript_cache()
    key = str(path)
    try:
        fd = os.open(key, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except (OSError, ValueError, TypeError):
        # Not a regular file, a symlink or not there at all.
        return None
    try:
        try:
            info = os.fstat(fd)
        except OSError:
            return None
        if not stat.S_ISREG(info.st_mode):
            # A device, a fifo or a socket is not a transcript.
            return None
        size = info.st_size
        mtime_ns = info.st_mtime_ns
        session = cache["sessions"].setdefault(session_key, _new_session())
        entry = cache["files"].get(key)
        if entry is None:
            entry = _new_file_entry(session_key)
            cache["files"][key] = entry
        elif entry.get("reset"):
            # The cached weights were not finite: the file is read again
            # from the start, and its request ids are forgotten, so that
            # its messages are counted again instead of being suppressed.
            _forget_ids(cache["files"], cache["sessions"], session_key, entry)
            _reset_file_entry(entry)
        elif (
            size < entry["offset"]
            or (size == entry["size"] and mtime_ns != entry["mtime_ns"])
        ):
            # The file was rewritten: it is read from the start again.
            _forget_ids(cache["files"], cache["sessions"], session_key, entry)
            _reset_file_entry(entry)
        entry["used"] = time.time()
        pending = entry["pending"]
        # The bytes that were read but not consumed are not read again.
        read_from = entry["offset"] + len(pending)
        if size > read_from:
            chunk = _read_bytes(fd, read_from)
            if chunk:
                buffer = pending + chunk
                end = buffer.rfind(b"\n")
                if end >= 0:
                    for line in buffer[: end + 1].split(b"\n"):
                        consume_line(entry, line, session, is_parent, cache)
                    entry["offset"] += end + 1
                    entry["pending"] = b""
                else:
                    # No complete line: the tail stays unconsumed, but the
                    # bytes that were read are not read again on the next
                    # run.
                    entry["pending"] = buffer
                    if len(entry["pending"]) > MAX_PENDING_BYTES:
                        # The tail is longer than is kept: its oldest part
                        # is dropped, and the line it belongs to can no
                        # longer be parsed anyway.
                        drop = len(entry["pending"]) - MAX_PENDING_BYTES
                        entry["offset"] += drop
                        entry["pending"] = entry["pending"][drop:]
                        # The dropped bytes are lost for good, so the file's
                        # weight is an undercount: it is marked, so that the
                        # split is not shown as if it were exact.
                        entry["dropped"] = entry.get("dropped", 0) + drop
                _TRANSCRIPT_DIRTY = True
        _trim_seen(session["main_ids"])
        _trim_seen(session["side_ids"])
        entry["size"] = max(size, entry["offset"])
        entry["mtime_ns"] = mtime_ns
        return entry
    finally:
        os.close(fd)


def _mtime_ns(path):
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def cost_split(transcript_path, total):
    """The orchestrator's and the subagents' costs, or None when unknown.

    Claude Code's total_cost_usd includes the subagents' spend. The two
    sides are priced with the same weighted token units and scaled to that
    total, so they add up to it exactly, whatever the model id is.
    """
    # The path comes from the session JSON, so it is not trusted: it has to
    # be a string, and a string with a NUL byte in it would raise further
    # down and take the whole status line with it.
    if not isinstance(transcript_path, str) or not transcript_path or "\0" in transcript_path:
        return None
    if not total or total <= 0:
        return None
    parent = Path(transcript_path)
    session_key = "%s/%s" % (parent.parent, parent.stem)
    entry = parse_transcript(parent, session_key, True)
    if entry is None:
        return None
    if entry.get("poisoned") or entry.get("dropped"):
        # A weight of the parent overflowed, or bytes of it were dropped
        # because a line was too long: its numbers cannot be trusted, so
        # no split is computed.
        return None
    weight_parent = entry["w_main"]
    # Sidechain entries in the parent transcript belong to a subagent, so
    # they count towards the child side.
    weight_child = entry["w_side"]
    # The subagents write their own transcripts into the "subagents"
    # directory of the session, next to the parent's transcript. Only that
    # session scoped directory is used: a "subagents" directory next to the
    # transcript itself is shared by every session of the project, so its
    # files would be counted into the wrong session.
    directory = parent.parent / parent.stem / "subagents"
    try:
        children = sorted(directory.glob("agent-*.jsonl"), key=_mtime_ns, reverse=True)
    except OSError:
        children = []
    for child in children[:MAX_CHILD_TRANSCRIPTS]:
        child_entry = parse_transcript(child, session_key, False)
        if child_entry is None:
            continue
        if child_entry.get("poisoned") or child_entry.get("dropped"):
            # The child's weight is not exact either, so the split is not
            # computed.
            return None
        weight_child += child_entry["w_main"] + child_entry["w_side"]
    total_weight = weight_parent + weight_child
    # A sum that overflowed is not a price: the split is not computed at
    # all, so that no non-finite number can reach the status line.
    if not all(math.isfinite(weight) for weight in (weight_parent, weight_child, total_weight)):
        return None
    if total_weight <= 0:
        return None
    price = total / total_weight
    orchestrator = price * weight_parent
    subagents = price * weight_child
    if not all(math.isfinite(value) for value in (price, orchestrator, subagents)):
        return None
    return orchestrator, subagents


def usable_percent(value):
    """The context percentage, or None when it is not a usable percentage.

    A percentage has to be a finite number within 0..MAX_CONTEXT_PERCENT: an
    over-100 % estimate is possible, but a magnitude such as 1e300 is not a
    percentage at all. The readout, the thresholds and the bar all follow
    this one value, so they can never disagree.
    """
    number = finite_number(value)
    if number is None or not 0 <= number <= MAX_CONTEXT_PERCENT:
        return None
    return number


def context_bar(percent, width, color):
    """The context usage bar: filled cells in `color`, empty ones muted.

    The filled count is the percentage of the bar, rounded half up like
    JavaScript's Math.round, so both footers agree cell for cell. A small
    but non-zero usage still shows one filled cell. The empty cells are
    muted, not dim: dim is the brightest colour of the theme and would make
    the unused part the loudest.
    """
    filled = int(percent / 100.0 * width + 0.5)
    filled = max(0, min(width, filled))
    if percent > 0 and filled == 0:
        filled = 1
    pieces = []
    if filled > 0:
        pieces.append((BAR_FILLED * filled, color))
    if filled < width:
        pieces.append((BAR_EMPTY * (width - filled), MUTED))
    return pieces


def items_plain(items):
    """The plain text of the line-2 items, joined by a space."""
    return " ".join("".join(text for text, _ in item) for item in items)


def items_width(items):
    return visible_width(items_plain(items))


def paint_items(items):
    """Paint every piece of every item; the items are joined by a space."""
    return " ".join("".join(paint(color, text) for text, color in item) for item in items)


def truncate(text, width, ellipsis="..."):
    """Cut plain text to `width` columns, ending in the ellipsis when cut.

    The result is never wider than `width`: when the ellipsis alone does not
    fit, it is cut as well.
    """
    if visible_width(text) <= width:
        return text
    if width <= len(ellipsis):
        return ellipsis[:max(0, width)]
    keep = max(0, width - len(ellipsis))
    out = ""
    for char in text:
        if visible_width(out + char) > keep:
            break
        out += char
    return out + ellipsis


def format_cost(value):
    """A cost as "$0.048".

    A real spend that rounds to zero would read as no spend at all, so it is
    shown as "<$0.001" instead. A value that is not a finite number never
    reaches this point, but it is rejected here as well, so that "$nan" or
    "$inf" can never be printed.
    """
    number = finite_number(value)
    if number is None:
        return "$0.000"
    text = "$%.3f" % number
    if number > 0 and text == "$0.000":
        return "<$0.001"
    return text


def format_tokens(count):
    """Token formatting, same as Pi's footer."""
    if count < 1000:
        return str(int(count))
    if count < 10000:
        return "%.1fk" % (count / 1000)
    if count < 1000000:
        return "%dk" % round(count / 1000)
    if count < 10000000:
        return "%.1fM" % (count / 1000000)
    return "%dM" % round(count / 1000000)


def format_cwd(cwd, home):
    """Home-relative with a leading ~, same as Pi's footer."""
    try:
        relative = Path(cwd).resolve().relative_to(Path(home).resolve())
    except (ValueError, OSError):
        return cwd
    return "~" if str(relative) == "." else "~/%s" % relative


def git_branch(cwd):
    """Read the branch from .git/HEAD; git itself is never run, so a hostile
    repository config cannot execute anything from the status line."""
    start = Path(cwd)
    head = None
    for directory in [start] + list(start.parents):
        dotgit = directory / ".git"
        try:
            if dotgit.is_dir():
                head = dotgit / "HEAD"
                break
            if dotgit.is_file():  # linked worktree or submodule
                match = re.match(r"gitdir:\s*(.+)", dotgit.read_text().strip())
                if not match:
                    return None
                gitdir = Path(match.group(1))
                head = (gitdir if gitdir.is_absolute() else directory / gitdir) / "HEAD"
                break
        except OSError:
            return None
    if head is None:
        return None
    try:
        content = head.read_text().strip()
    except OSError:
        return None
    if content.startswith("ref: refs/heads/"):
        return content[len("ref: refs/heads/"):]
    if content.startswith("ref: "):
        return content[len("ref: "):]
    return content[:7] or None  # detached HEAD


def derive_persona(prompt):
    """Port of agent-name-hint.ts derivePersona.

    Skip YAML frontmatter and fenced code, then take the first top-level
    heading (at most 48 chars). Pi's version also took a `##` heading or the
    first sentence, but the specialist prompts have no H1 and start with
    `## Mission` or `## Shell`, so the caller falls back to the agent's name.
    """
    in_frontmatter = False
    in_fence = False
    for raw in prompt.split("\n"):
        line = raw.strip()
        if line == "---" and not in_fence:
            in_frontmatter = not in_frontmatter
            continue
        if in_frontmatter:
            continue
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heading = re.match(r"^#\s+(.+?)\s*$", line)
        if heading:
            cleaned = re.sub(r"[`*_]", "", heading.group(1)).strip()
            if cleaned:
                return cleaned[:48]
    return None


def persona_for(agent_name, config_dir, project_dir):
    if not agent_name:
        return FALLBACK_PERSONA
    # A project agent overrides a user agent of the same name.
    for base in (Path(project_dir) / ".claude" / "agents", Path(config_dir) / "agents"):
        path = base / ("%s.md" % agent_name)
        try:
            if path.is_file():
                return derive_persona(path.read_text()) or agent_name
        except OSError:
            continue
    return agent_name


def render(data, width):
    workspace = data.get("workspace") or {}
    cwd = workspace.get("current_dir") or data.get("cwd") or os.getcwd()
    project_dir = workspace.get("project_dir") or cwd
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")

    # Line 1: cwd (branch) • session name
    pwd = format_cwd(cwd, os.environ.get("HOME") or os.environ.get("USERPROFILE"))
    branch = git_branch(cwd)
    if branch:
        pwd = "%s (%s)" % (pwd, branch)
    if data.get("session_name"):
        pwd = "%s • %s" % (pwd, data["session_name"])
    line1 = paint(DIM, truncate(pwd, width))

    # Line 2: cost, the context bar and the context readout on the left;
    # model and effort on the right.
    segments = []
    # The cost is validated: a string or a huge integer would raise and take
    # the whole status line down with it. A zero cost shows no segment, as
    # it always has.
    cost = finite_number((data.get("cost") or {}).get("total_cost_usd"))
    if cost:
        # The orchestrator's own cost and the subagents' cost are two
        # segments of the same total: the orchestrator's in the accent
        # purple, the subagents' in the success green behind a plain "+".
        # When the split cannot be computed, only the single cost is shown.
        split = cost_split(data.get("transcript_path"), cost)
        if split:
            orchestrator, subagents = split
            segments.append([(format_cost(orchestrator), ACCENT)])
            if subagents > 0:
                segments.append([("+", None), (format_cost(subagents), GREEN)])
        else:
            segments.append([(format_cost(cost), ACCENT)])
    window = data.get("context_window") or {}
    # The percentage is validated once, up front: the readout, the
    # thresholds and the bar all use this one value, so they can never
    # disagree. A percentage that is not usable is treated like a missing
    # one: the readout says so and no bar is drawn.
    percent = usable_percent(window.get("used_percentage"))
    size = format_tokens(window.get("context_window_size") or 0)
    context = ("%.1f%%/%s" % (percent, size)) if percent is not None else "?/%s" % size
    usage = percent if percent is not None else 0
    context_color = ERROR if usage > 90 else WARNING if usage > 70 else DIM
    # The bar's filled cells follow the same thresholds, but a healthy usage
    # is accent (purple) rather than the dim text colour.
    bar_color = ERROR if usage > 90 else WARNING if usage > 70 else ACCENT

    model = (data.get("model") or {}).get("id") or "no-model"
    effort = (data.get("effort") or {}).get("level")
    right_plain = "%s • %s" % (model, effort) if effort else model

    def build_left(bar_width, with_subagents=True, with_context=True):
        items = list(segments if with_subagents else segments[:1])
        if bar_width:
            items.append(context_bar(percent, bar_width, bar_color))
        if with_context:
            items.append([(context, context_color)])
        return items

    # The left half gives way to the right one: the bar shrinks first, then
    # it goes, and only then do the numbers go. The model stays on screen.
    right_width = visible_width(right_plain)
    candidates = []
    has_window = percent is not None and (window.get("context_window_size") or 0) > 0
    bar_widths = BAR_WIDTHS if has_window else ()
    for bar_width in list(bar_widths) + [None]:
        candidates.append(build_left(bar_width))
    candidates.append(build_left(None, with_subagents=False))
    candidates.append(build_left(None, with_subagents=False, with_context=False))
    left_items = candidates[-1]
    for candidate in candidates:
        if items_width(candidate) + MIN_PADDING + right_width <= width:
            left_items = candidate
            break

    left_plain = items_plain(left_items)
    if visible_width(left_plain) > width:
        # Too narrow for the whole left half: cut it with an ellipsis and
        # paint it dim, like the previous version did, but leave the right
        # half the room it needs.
        budget = width - MIN_PADDING - right_width
        left_plain = truncate(left_plain, budget) if budget > 0 else ""
        left_items = [[(left_plain, DIM)]]
    left = paint_items(left_items)
    left_width = visible_width(left_plain)
    if left_width + MIN_PADDING + visible_width(right_plain) <= width:
        line2 = left + " " * (width - left_width - visible_width(right_plain)) + paint(DIM, right_plain)
    else:
        available = width - left_width - MIN_PADDING
        right_plain = truncate(right_plain, available, "") if available > 0 else ""
        line2 = left + (" " * (MIN_PADDING) + paint(DIM, right_plain) if right_plain else "")

    # Line 3: the agent hint.
    persona = persona_for((data.get("agent") or {}).get("name"), config_dir, project_dir)
    line3 = "%s %s" % (paint(ACCENT, "●"), truncate(persona, width - 2))

    return [line1, line2, line3]


def main():
    global _READ_BUDGET
    # The read budget is per invocation: every status line run starts with
    # the whole budget.
    _READ_BUDGET = MAX_RUN_READ_BYTES
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            data = {}
    except (ValueError, OSError):
        data = {}
    columns = os.environ.get("COLUMNS")
    width = int(columns) if columns and columns.isdigit() else shutil.get_terminal_size((80, 24)).columns
    try:
        lines = render(data, max(20, width - MARGIN))
    except Exception:  # a status line must never break the session
        lines = ["%s %s" % (paint(ACCENT, "●"), FALLBACK_PERSONA)]
    try:
        save_transcript_cache()
    except Exception:  # a cache that cannot be written is not worth a crash
        pass
    print("\n".join(lines))


if __name__ == "__main__":
    main()
