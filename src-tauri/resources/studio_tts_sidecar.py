#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Yusuf Al-Bazian
#
# Redline "studio voice" TTS sidecar: Qwen3-TTS (12 Hz, 0.6B/1.7B) on MLX via
# mlx-audio. A long-lived helper that Redline spawns from its private uv venv.
# It speaks newline-delimited JSON on stdio, extending the Kokoro sidecar's
# contract (one object per line in each direction) with ids, generations,
# streamed audio chunks and out-of-band control.
#
# stdin, one JSON object per line:
#   {"id":"r1","generation":7,"op":"speak","text":"...","voice":"ryan",
#    "instruct":"calm and warm","speed":1.0,"stream":true,"format":"pcm16"}
#     optional: "normalize" (true: speakable identifiers), "trim" (true: silence
#     shaping), "temperature" (0.7), "seed", "interval" (0.32 s per chunk),
#     "supersede" (true: a newer generation cancels older ones), "lang".
#     voice: a preset ("ryan"), "clone:<id>" (Base model, consented reference in
#     --voices-dir) or "design:<id>" (VoiceDesign model, <id>.design.txt).
#     "speed" is accepted but not applied (mlx-audio's Qwen3 path ignores it);
#     capabilities.speed = "client" says so, and pace comes from an instruction.
#   {"op":"cancel","generation":7}          cancel generation <= 7 (in flight + queued)
#   {"op":"cancel","id":"r1"}               cancel one request
#   {"op":"cancel","all":true}              cancel everything
#   {"id":"w","op":"warmup"}                load the model + one tiny synthesis
#   {"id":"u","op":"unload"}                drop the model, return GPU memory
#   {"id":"l","op":"load","model":"<dir>"}  switch model directory (under --models-root)
#   {"id":"h","op":"health"}                state / memory / queue (answered immediately)
#   {"id":"v","op":"voices"}                speakers, kinds, capabilities (immediately)
#   {"op":"shutdown"}
#
# stdout, one JSON object per line. Every request with an id gets exactly one
# message with "final": true (a terminal "end", "error" or "cancelled"; for
# stream:false the single "chunk" is final). Unsolicited events have no id.
#   {"type":"hello","protocol":1,...}                         once, at startup
#   {"type":"state","state":"loading|ready|unloaded",...}     unsolicited
#   {"type":"chunk","id","generation","seq":0,"final":false,"sr":24000,
#    "pcm16":"<base64 little-endian int16 mono>","samples":7680}
#   {"type":"end","id","generation","seq":N,"final":true,"stats":{...}}
#   {"type":"cancelled","id","generation","final":true,"stats":{...}}
#   {"type":"error","id","generation","code":"...","message":"...","final":true}
#   {"type":"warm"|"unloaded"|"loaded"|"health"|"voices","id",...,"final":true}
#   stats: queue_ms, load_ms, first_raw_ms, first_audio_ms, gen_ms, raw_audio_ms,
#   audio_ms, trimmed_ms, tokens, chunks, cap_hit, rtf, encode_ms, mlx_peak_mb,
#   cancel_latency_ms (cancelled only), spoken_text (when normalized).
#
# Non-protocol output never reaches stdout: fd 1 is re-pointed at stderr before
# any library is imported, and protocol lines go to a private dup of the
# original stdout. Redline drains stderr into its log.
#
# Process isolation also keeps the Python/MLX stack (and its ~GB of weights)
# outside Redline's Apache-2.0 binary: only text and audio bytes cross the pipe.

#
# Hardening (adversarial break tests, 2026-10-10):
#   - a malformed line (non-hashable id/target, invalid UTF-8, bad field types) is answered
#     with a coded error instead of crashing the process;
#   - stderr that cannot be written (closed pipe, full disk) can no longer kill the worker
#     thread and hang every later request; if the worker ever dies anyway, the sidecar emits
#     {"type":"fatal"} and exits so Redline sees EOF and falls back;
#   - the frame cap is computed on an estimate of SPOKEN length (digits and CJK expand), with
#     a floor, so numbers, short replies and CJK are no longer truncated mid-word;
#   - long text is split into pieces and streamed under one id instead of being refused;
#   - text hygiene: drops ⟦…⟧ markers and everything after ⟦screen⟧, fenced code, control /
#     zero-width chars and lone surrogates; text with nothing speakable is rejected up front;
#   - idle unload no longer fires right after a `load`; critical memory pressure unloads;
#   - protocol writes loop until the whole line is written.

import os
import sys

# --- 1. Own stdout before anything else can write to it --------------------
_PROTO_FD = os.dup(1)
os.dup2(2, 1)


class _SafeStream:
    """stderr/stdout replacement that never raises: a log line that cannot be written
    (EPIPE from a dead drain task, EFBIG/ENOSPC from a full disk) is dropped. Library
    code prints during model load; an exception there must not take the worker down."""

    def __init__(self, raw):
        self._raw = raw

    def write(self, s):
        try:
            return self._raw.write(s)
        except Exception:  # noqa: BLE001
            return len(s) if isinstance(s, str) else 0

    def flush(self):
        try:
            self._raw.flush()
        except Exception:  # noqa: BLE001
            pass

    def __getattr__(self, name):
        return getattr(self._raw, name)


sys.stderr = _SafeStream(sys.stderr)
sys.stdout = sys.stderr
_PROTO = os.fdopen(_PROTO_FD, "wb", buffering=0)

for _k, _v in {
    "HF_HUB_OFFLINE": "1",  # never touch the network at runtime
    "TRANSFORMERS_OFFLINE": "1",
    "TRANSFORMERS_VERBOSITY": "error",
    "TOKENIZERS_PARALLELISM": "false",
    "TQDM_DISABLE": "1",
    "PYTHONWARNINGS": "ignore",
}.items():
    os.environ.setdefault(_k, _v)

import argparse  # noqa: E402
import base64  # noqa: E402
import collections  # noqa: E402
import ctypes  # noqa: E402
import gc  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import struct  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402

import numpy as np  # noqa: E402  (light; mlx is imported lazily)

PROTOCOL = 1
SR = 24000
MAX_CHARS = 20000  # hard guard; longer text is split into PIECE_CHARS pieces internally
PIECE_CHARS = 360  # one model call per piece: bounds a runaway and the KV cache
LANGS = {"auto", "english", "chinese", "japanese", "korean", "german", "french", "russian", "portuguese", "spanish", "italian"}
FORMATS = {"pcm16", "wav"}

# Preset speakers shipped in the CustomVoice checkpoints (Qwen3-TTS model card).
SPEAKERS = {
    "ryan": ("male", "English", "Dynamic male voice with strong rhythmic drive"),
    "aiden": ("male", "English", "Sunny American male voice with a clear midrange"),
    "vivian": ("female", "Chinese", "Bright, slightly edgy young female voice"),
    "serena": ("female", "Chinese", "Warm, gentle young female voice"),
    "uncle_fu": ("male", "Chinese", "Seasoned male voice with a low, mellow timbre"),
    "dylan": ("male", "Chinese (Beijing)", "Youthful Beijing male voice"),
    "eric": ("male", "Chinese (Sichuan)", "Lively Chengdu male voice, slightly husky"),
    "ono_anna": ("female", "Japanese", "Playful Japanese female voice"),
    "sohee": ("female", "Korean", "Warm Korean female voice"),
}

_emit_lock = threading.Lock()
T_START = time.monotonic()


def emit(obj):
    line = (json.dumps(obj, separators=(",", ":"), default=str) + "\n").encode("utf-8", "replace")
    with _emit_lock:
        view = memoryview(line)
        try:
            while view:  # a raw write may be partial (signal mid-write): never leave half a line
                n = _PROTO.write(view)
                view = view[n or 0:]
        except (BrokenPipeError, ValueError, OSError):
            os._exit(0)  # Redline closed our stdout: nobody is listening


def log(msg):
    try:
        sys.stderr.write("[studio-sidecar] " + str(msg) + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001  (logging must never take the sidecar down)
        pass


def _json_id(v):
    """Ids are echoed back and used as set keys: only strings and integers are accepted."""
    return v is None or isinstance(v, str) or (isinstance(v, int) and not isinstance(v, bool))


def ms(t):
    return round(t * 1000.0, 1)


# --- process memory (phys_footprint, what Activity Monitor shows) ----------
try:
    _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    _libc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
except Exception:  # noqa: BLE001
    _libc = None


def footprint():
    if _libc is None:
        return None
    buf = ctypes.create_string_buffer(512)
    if _libc.proc_pid_rusage(os.getpid(), 4, buf) != 0:
        return None
    return {
        "footprint_mb": round(struct.unpack_from("<Q", buf.raw, 72)[0] / 1e6),
        "max_footprint_mb": round(struct.unpack_from("<Q", buf.raw, 240)[0] / 1e6),
    }


def pressure_level():
    """macOS VM pressure: 1 normal, 2 warn, 4 critical (None if unavailable)."""
    if _libc is None:
        return None
    try:
        v = ctypes.c_int(0)
        n = ctypes.c_size_t(ctypes.sizeof(v))
        if _libc.sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(v), ctypes.byref(n), None, 0) != 0:
            return None
        return v.value
    except Exception:  # noqa: BLE001
        return None


class Cancelled(Exception):
    pass


# --- text hygiene: what a voice should not read aloud -----------------------
_MD = re.compile(r"[*`#>|]+|(?<!\w)_+|_+(?!\w)")
_WS = re.compile(r"\s+")
# File extensions the model otherwise blurs into the name ("VoicePanel.tsx" was
# heard as "VoicePanelDunceX").
_EXT = {"tsx": "T S X", "ts": "T S", "jsx": "J S X", "js": "J S", "rs": "R S", "py": "P Y", "md": "markdown",
        "json": "JSON", "toml": "toml", "yaml": "yaml", "yml": "yaml", "css": "C S S", "html": "H T M L",
        "sh": "shell", "sql": "S Q L", "swift": "Swift", "go": "Go", "txt": "text", "lock": "lock", "wav": "wave"}
# Respellings for terms Qwen3-TTS mispronounced in testing.
_LEX = [
    (re.compile(r"\bSQLite\b"), "S Q Lite"),
    (re.compile(r"\bbarge-in\b", re.I), "barge in"),
    (re.compile(r"(?<=\d)\s?kHz\b"), " kilohertz"),
    (re.compile(r"(?<=\d)\s?ms\b"), " milliseconds"),
    (re.compile(r"(?<=\d)\s?MB\b"), " megabytes"),
    (re.compile(r"(?<=\d)\s?GB\b"), " gigabytes"),
    (re.compile(r"\bv(\d+(?:\.\d+)+)\b"), r"version \1"),
    (re.compile(r"\s*(?:->|=>)\s*"), " to "),
    (re.compile(r"\s*&&\s*"), " and "),
]
_FILE = re.compile(r"\b([A-Za-z][\w-]*)\.(" + "|".join(sorted(_EXT, key=len, reverse=True)) + r")\b")
_CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z][a-z])")
_SNAKE = re.compile(r"(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])")
_PATHSEP = re.compile(r"(?<=\w)/(?=\w)")


_SCREEN = re.compile(r"⟦\s*screen\s*⟧.*\Z", re.S)  # everything after the screen marker is never spoken
_MARKER = re.compile(r"⟦[^⟧]{0,80}⟧")  # ⟦tone: …⟧, ⟦§anchor⟧ and friends
_FENCE = re.compile(r"```.*?(?:```|\Z)", re.S)  # fenced code (closed, or open to the end of the text)
_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]")
_SPEAKABLE_SCRIPT = re.compile(r"[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]")


def _scrub(text):
    """Remove what no TTS should see: lone surrogates, control and zero-width/format
    characters (keeping newlines/tabs as spaces), and symbols such as emoji."""
    import unicodedata
    out = []
    for ch in text.replace("�", " "):
        cat = unicodedata.category(ch)
        if cat == "Cf":
            out.append("")  # zero-width / bidi / soft hyphen: invisible, drop in place
        elif cat in ("Cc", "Co", "Cs", "Cn"):
            out.append(" ")  # control chars, private use, lone surrogates, unassigned
        elif cat == "So" or cat == "Sk":
            out.append(" ")
        elif cat[0] == "L" and not _SPEAKABLE_SCRIPT.match(ch):
            out.append(" ")  # a script the model cannot read (Arabic, Hebrew, Thai, …) would be babbled
        else:
            out.append(ch)
    return "".join(out)


def clean_text(text, normalize=True):
    text = _SCREEN.sub(" ", text)
    text = _MARKER.sub(" ", text).replace("⟦", " ").replace("⟧", " ")
    text = _FENCE.sub(" ", text)
    text = _scrub(text)
    text = re.sub(r"\bhttps?://\S+", " a link ", text)
    if normalize:
        for pat, rep in _LEX:
            text = pat.sub(rep, text)
        text = _FILE.sub(lambda m: f"{m.group(1)} dot {_EXT[m.group(2)]}", text)
        text = _CAMEL.sub(" ", text)
        text = _SNAKE.sub(" ", text)
        text = _PATHSEP.sub(" slash ", text)
    text = _MD.sub(" ", text)
    text = _WS.sub(" ", text).strip()
    return re.sub(r" ([,.;:!?])", r"\1", text)  # "release 🎉, the" -> "release, the"


def speakable(text):
    """True when the cleaned text has at least one letter/digit in a script Qwen3-TTS reads
    (Latin, Greek, Cyrillic, CJK, kana, Hangul). Emoji-only, punctuation-only, Arabic-only…
    would otherwise make the model hum ("Hmm…") or babble until the cap."""
    return bool(_SPEAKABLE_SCRIPT.search(text))


def guess_lang(text):
    """Default language: English unless the text is mostly CJK/kana/Hangul (the model then
    needs the matching language or it reads two words and stops)."""
    cjk = len(_CJK.findall(text))
    letters = sum(ch.isalpha() for ch in text) or 1
    if cjk / letters < 0.5:
        return "english"
    if re.search(r"[぀-ヿ]", text):
        return "japanese"
    if re.search(r"[가-힯]", text):
        return "korean"
    return "chinese"


def spoken_units(text):
    """Rough length of the text AS SPOKEN, in Latin-character units: digits expand
    ("1,234,567,890" is ~95 spoken characters), CJK characters are a syllable each."""
    digits = sum(ch.isdigit() for ch in text)
    cjk = len(_CJK.findall(text))
    syms = sum(ch in "%$€£&@+=#" for ch in text)
    return len(text) - digits - cjk - syms + 5 * digits + 3.5 * cjk + 6 * syms


def token_cap(text, instructed=False, long_silence=True):
    # 12.5 codec frames per second of audio. A missed EOS or a babble runs on until the
    # cap; mlx-audio's own default is 4096 frames (327 s). Measured (verifier, 120 seeded
    # reads, temp 0.7): clean reads need up to ~1.3 frames per spoken unit plus up to ~45
    # frames of lead/tail silence and short-word overhead on 0.6B; number-heavy lines need
    # 2-2.6 frames per *character*, which the earlier 1.8*chars+20 cap truncated every time
    # on 0.6B. The cap sits ~1.6-2x above clean reads: it bounds a runaway without cutting
    # legitimate speech. "Speak slowly" instructions get more room.
    # The fixed part covers lead/tail silence: ~0.9 s on 0.6B, ~0.13 s on 1.7B (measured), so
    # a one-word reply ("Sure.", 8-14 frames on 1.7B) that runs on is cut at ~2.6 s, not 4.2 s.
    u = spoken_units(text)
    if instructed:
        return int(2.2 * u + (50 if long_silence else 30))
    return int(1.6 * u + (45 if long_silence else 25))


def split_pieces(text, limit=PIECE_CHARS):
    """Split long text at sentence ends, then clause marks, then spaces, into pieces of at
    most `limit` characters. Short text is returned as one piece."""
    if len(text) <= limit:
        return [text]
    pieces, cur = [], ""
    for sent in re.split(r"(?<=[.!?])\s+|(?<=[。！？])", text):
        while len(sent) > limit:
            cut = max(sent.rfind(m, 0, limit) for m in (", ", "; ", ": ", " — ", " - ", "，", "、", "；"))
            if cut < limit // 3:
                cut = sent.rfind(" ", 0, limit)
            if cut < limit // 3:
                cut = limit
            head, sent = sent[: cut + 1].strip(), sent[cut + 1:].strip()
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(head)
        if cur and len(cur) + 1 + len(sent) > limit:
            pieces.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        pieces.append(cur)
    return [p for p in pieces if p]


class SilenceShaper:
    """Streaming silence trimmer. Qwen3-TTS opens every utterance with ~0.43 s
    and closes with ~0.46 s of silence (measured), and sometimes pauses 1-2 s
    mid-sentence. Voiced audio is emitted the moment it exists; silence is held
    back and only released (capped) when more voice follows, so trimming adds
    no latency to audible speech."""

    FRAME = 240  # 10 ms at 24 kHz

    def __init__(self, thr=0.01, lead_ms=30, max_pause_ms=700, tail_ms=220):
        self.thr = thr
        self.lead = int(lead_ms * 24)
        self.max_pause = int(max_pause_ms * 24)
        self.tail = int(tail_ms * 24)
        self.started = False
        self.pending = []  # held silent samples (numpy arrays)
        self.carry = None  # < FRAME leftover samples
        self.dropped = 0

    def _held(self):
        return np.concatenate(self.pending) if self.pending else np.zeros(0, np.float32)

    def push(self, x):
        if self.carry is not None and len(self.carry):
            x = np.concatenate([self.carry, x])
        n = len(x) // self.FRAME * self.FRAME
        self.carry = x[n:]
        out = []
        if n == 0:
            return np.zeros(0, np.float32)
        frames = x[:n].reshape(-1, self.FRAME)
        voiced = np.max(np.abs(frames), axis=1) > self.thr
        i = 0
        while i < len(frames):
            j = i
            while j < len(frames) and voiced[j] == voiced[i]:
                j += 1
            seg = frames[i:j].reshape(-1)
            if voiced[i]:
                held = self._held()
                self.pending = []
                if not self.started:
                    keep = held[-self.lead:] if self.lead else held[:0]
                    self.started = True
                elif len(held) > self.max_pause:
                    tail = min(1200, self.max_pause // 2)  # keep 50 ms before the onset
                    keep = np.concatenate([held[: self.max_pause - tail], held[-tail:]])
                else:
                    keep = held
                self.dropped += len(held) - len(keep)
                out.append(keep)
                out.append(seg)
            else:
                self.pending.append(seg)
            i = j
        return np.concatenate(out) if out else np.zeros(0, np.float32)

    def finish(self):
        held = self._held()
        if self.carry is not None and len(self.carry):
            held = np.concatenate([held, self.carry])
        self.pending, self.carry = [], None
        if not self.started:
            return np.zeros(0, np.float32)
        keep = held[: self.tail]
        self.dropped += len(held) - len(keep)
        return keep


class Sidecar:
    def __init__(self, args):
        self.args = args
        self.models_root = os.path.abspath(args.models_root)
        self.model_name = args.model
        self.voices_dir = os.path.abspath(args.voices_dir) if args.voices_dir else None
        self.model = None
        self.kind = None
        self.mx = None
        self.state = "cold"  # cold | loading | ready | busy | unloaded
        self.q = collections.deque()
        self.cv = threading.Condition()
        self.lock = threading.Lock()  # guards cancel state + current
        self.cancel_upto = None  # generations <= this are dead
        self.cancel_ids = set()
        self.cancel_at = {}  # generation/id -> monotonic time the cancel arrived
        self.max_generation = None
        self.current = None  # the request being synthesized
        self.cancel_event = threading.Event()  # set when `current` goes stale
        self.shutdown = False
        self.last_used = time.monotonic()
        self.ref_cache = {}
        self.served = 0

    # ---- cancellation ----------------------------------------------------
    def _stale(self, req):
        g = req.get("generation")
        if req.get("id") is not None and req.get("id") in self.cancel_ids:
            return True
        if g is not None and self.cancel_upto is not None and g <= self.cancel_upto:
            return True
        return False

    def _cancel_received_at(self, req):
        if ("i", req.get("id")) in self.cancel_at:
            return self.cancel_at[("i", req.get("id"))]
        g = req.get("generation")
        best = None
        for (kind, key), t in list(self.cancel_at.items()):
            if kind == "g" and g is not None and key >= g:
                best = t if best is None else min(best, t)
        return best

    def _apply_cancel(self, generation=None, rid=None, everything=False):
        now = time.monotonic()
        dropped = []
        with self.lock:
            if everything:
                top = self.max_generation if self.max_generation is not None else 0
                generation = top if generation is None else max(generation, top)
                for r in list(self.q):
                    if r.get("id") is not None:
                        self.cancel_ids.add(r.get("id"))
                if self.current is not None and self.current.get("id") is not None:
                    self.cancel_ids.add(self.current.get("id"))
            if generation is not None:
                self.cancel_upto = generation if self.cancel_upto is None else max(self.cancel_upto, generation)
                self.cancel_at[("g", generation)] = now
            if rid is not None:
                self.cancel_ids.add(rid)
                self.cancel_at[("i", rid)] = now
            if self.current is not None and self._stale(self.current):
                self.cancel_event.set()
        with self.cv:
            keep = collections.deque()
            while self.q:
                r = self.q.popleft()
                if r.get("op") == "speak" and self._stale(r):
                    dropped.append(r)
                else:
                    keep.append(r)
            self.q = keep
        for r in dropped:
            emit({"type": "cancelled", "id": r.get("id"), "generation": r.get("generation"), "final": True,
                  "stats": {"stage": "queued", "queue_ms": ms(now - r["_t_enq"])}})
        if len(self.cancel_at) > 256:  # bounded bookkeeping
            for k in list(self.cancel_at)[:128]:
                self.cancel_at.pop(k, None)
        if len(self.cancel_ids) > 1024:
            self.cancel_ids = set(list(self.cancel_ids)[-256:])

    # ---- model lifecycle -------------------------------------------------
    def _import_mlx(self):
        if self.mx is None:
            import mlx.core as mx
            self.mx = mx
            if self.args.cache_limit_mb >= 0:
                mx.set_cache_limit(self.args.cache_limit_mb * 1024 * 1024)
            if self.args.memory_limit_mb > 0:
                mx.set_memory_limit(self.args.memory_limit_mb * 1024 * 1024)
        return self.mx

    def _model_dir(self, name=None):
        name = name or self.model_name
        path = os.path.abspath(os.path.join(self.models_root, name))
        if not path.startswith(self.models_root + os.sep):
            raise ValueError("model must name a directory under the models root")
        return path

    def ensure_loaded(self):
        if self.model is not None:
            return 0.0
        self._import_mlx()
        from mlx_audio.tts.utils import load_model

        self.state = "loading"
        emit({"type": "state", "state": "loading", "model": self.model_name})
        t = time.monotonic()
        model = load_model(self._model_dir())
        self.kind = getattr(model.config, "tts_model_type", "base")
        orig = model._sample_token
        ev = self.cancel_event

        # Token-level cancellation: mlx-audio only yields every few frames, so
        # check the cancel flag on every sampling step (one ~15-25 ms frame).
        def checked(*a, **k):
            if ev.is_set():
                raise Cancelled()
            return orig(*a, **k)

        if not self.args.chunk_cancel_only:
            model._sample_token = checked
        self.model = model
        dt = time.monotonic() - t
        self.last_used = time.monotonic()  # idle time counts from the load, not from the last speak
        self.state = "ready"
        emit({"type": "state", "state": "ready", "model": self.model_name, "kind": self.kind, "load_ms": ms(dt)})
        return dt

    def unload(self, reason):
        if self.model is None:
            return 0.0
        t = time.monotonic()
        self.model = None
        self.ref_cache.clear()
        gc.collect()
        if self.mx is not None:
            self.mx.clear_cache()
        self.state = "unloaded"
        emit({"type": "state", "state": "unloaded", "reason": reason, "mem": footprint()})
        return time.monotonic() - t

    # ---- synthesis -------------------------------------------------------
    def _resolve_voice(self, req):
        """-> (generate kwargs, error code or None)."""
        voice = (req.get("voice") or "").strip()
        instruct = req.get("instruct")
        if instruct is not None and not isinstance(instruct, str):
            return None, "bad_instruct"
        instruct = (instruct or "").strip()[:400] or None
        kind = self.kind
        if voice.startswith("clone:"):
            if kind != "base":
                return None, "voice_needs_base_model"
            vid = voice.split(":", 1)[1]
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", vid) or not self.voices_dir:
                return None, "voice_unknown"
            wav = os.path.join(self.voices_dir, vid + ".wav")
            if not os.path.isfile(wav):
                return None, "voice_unknown"
            if vid not in self.ref_cache:
                # References are written by Redline as 24 kHz mono PCM16 WAV, so the
                # stdlib reads them (no miniaudio/scipy needed in the lean venv).
                import wave
                with wave.open(wav, "rb") as w:
                    if w.getframerate() != SR or w.getnchannels() != 1 or w.getsampwidth() != 2:
                        return None, "reference_must_be_24k_mono_pcm16"
                    ref = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
                if not 2.5 <= len(ref) / SR <= 30.0:
                    return None, "reference_length_2_5_to_30_s"
                txt = os.path.join(self.voices_dir, vid + ".txt")
                ref_text = open(txt, encoding="utf-8").read().strip() if os.path.isfile(txt) else None
                self.ref_cache[vid] = (self.mx.array(ref), ref_text)
            ref_audio, ref_text = self.ref_cache[vid]
            kw = {"ref_audio": ref_audio}
            if ref_text and not self.args.xvector_only:
                kw["ref_text"] = ref_text
            return kw, None
        if kind == "custom_voice":
            v = voice.lower() or "ryan"
            if v not in self.model.config.talker_config.spk_id:
                return None, "voice_unknown"
            kw = {"voice": v}
            if instruct:
                kw["instruct"] = instruct
            return kw, None
        if kind == "voice_design":
            desc = req.get("description") or instruct
            if voice.startswith("design:") and self.voices_dir:
                vid = voice.split(":", 1)[1]
                p = os.path.join(self.voices_dir, vid + ".design.txt")
                if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", vid) and os.path.isfile(p):
                    desc = open(p, encoding="utf-8").read().strip() + (" " + instruct if instruct else "")
            if not desc:
                return None, "design_needs_description"
            return {"instruct": desc[:600]}, None
        return None, "voice_unsupported"

    def speak(self, req):
        rid, gen = req.get("id"), req.get("generation")
        t0 = time.monotonic()
        queue_ms = ms(t0 - req["_t_enq"])
        load_s = self.ensure_loaded()
        mx = self.mx
        text = req["_clean"]  # cleaned + validated by the reader
        kw, err = self._resolve_voice(req)
        if err:
            emit({"type": "error", "id": rid, "generation": gen, "code": err, "message": f"voice {req.get('voice')!r}: {err}", "final": True})
            return
        stream = req.get("stream", True) is not False
        fmt = req.get("format") or "pcm16"
        interval, temperature = req["_interval"], req["_temperature"]
        lang = req.get("lang") or guess_lang(text)
        trim = req.get("trim", True) is not False
        seed = req.get("seed")
        if seed is not None:
            mx.random.seed(seed)
        pieces = split_pieces(text)
        with self.lock:
            self.current = req
            self.cancel_event.clear()
            if self._stale(req):
                self.cancel_event.set()
        self.state = "busy"
        self.last_used = time.monotonic()
        seq = 0
        raw_samples = 0
        out_samples = 0
        tokens = 0
        caps_hit = 0
        cap_total = 0
        first_raw = None
        first = None
        enc_s = 0.0
        acc = []
        cancelled = False

        def send(x):
            nonlocal seq, out_samples, enc_s, first
            if x is None or len(x) == 0:
                return
            te = time.monotonic()
            b = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            out_samples += len(x)
            if stream:
                emit({"type": "chunk", "id": rid, "generation": gen, "seq": seq, "final": False, "sr": SR,
                      "samples": len(x), "pcm16": base64.b64encode(b).decode("ascii")})
                seq += 1
                if first is None:
                    first = time.monotonic() - t0
            else:
                acc.append(b)
            enc_s += time.monotonic() - te

        mx.reset_peak_memory()
        t_gen = time.monotonic()
        gen_iter = None
        try:
            for piece in pieces:
                if self.cancel_event.is_set():
                    raise Cancelled()
                # One shaper per piece: lead trimmed to 30 ms, tail kept at 220 ms, so the seam
                # between two pieces sounds like a sentence break (~250 ms), not a 0.9 s gap.
                shaper = SilenceShaper() if trim else None
                cap = token_cap(piece, "instruct" in kw, long_silence=getattr(self.model.config, "tts_model_size", "0b6") == "0b6")
                cap_total += cap
                piece_tokens = 0
                # Always the streaming decoder, even for stream:false: decoding a whole
                # utterance at once peaks at 6-8 GB of MLX memory (measured), while the
                # streaming decoder stays near the weights.
                gen_iter = self.model.generate(text=piece, stream=True, streaming_interval=interval, max_tokens=cap,
                                               lang_code=lang, temperature=temperature, **kw)
                for r in gen_iter:
                    if self.cancel_event.is_set():
                        raise Cancelled()
                    a = np.asarray(r.audio, dtype=np.float32)
                    if first_raw is None:
                        first_raw = time.monotonic() - t0
                    raw_samples += len(a)
                    piece_tokens += int(r.token_count or 0)
                    send(shaper.push(a) if shaper else a)
                gen_iter.close()
                gen_iter = None
                if shaper:
                    send(shaper.finish())
                tokens += piece_tokens
                caps_hit += piece_tokens >= cap
        except Cancelled:
            cancelled = True
        except Exception as e:  # noqa: BLE001
            log("synth failed: " + "".join(traceback.format_exception_only(type(e), e)).strip())
            self._reset_decoder()
            emit({"type": "error", "id": rid, "generation": gen, "code": "synth_failed", "message": str(e)[:300], "final": True})
            return
        finally:
            if gen_iter is not None:
                try:
                    gen_iter.close()
                except Exception:  # noqa: BLE001
                    pass
            with self.lock:
                self.current = None
            self.state = "ready" if self.model is not None else self.state
            self.last_used = time.monotonic()
        gen_s = time.monotonic() - t_gen
        stats = {"queue_ms": queue_ms, "load_ms": ms(load_s), "first_raw_ms": ms(first_raw) if first_raw else None,
                 "first_audio_ms": ms(first) if first else None, "gen_ms": ms(gen_s),
                 "raw_audio_ms": round(raw_samples / SR * 1000), "audio_ms": round(out_samples / SR * 1000),
                 "trimmed_ms": round((raw_samples - out_samples) / SR * 1000), "tokens": tokens, "chunks": seq,
                 "pieces": len(pieces), "cap_frames": cap_total, "cap_hit": caps_hit > 0, "caps_hit": caps_hit,
                 "rtf": round(gen_s / (raw_samples / SR), 3) if raw_samples else None, "encode_ms": ms(enc_s),
                 "mlx_peak_mb": round(mx.get_peak_memory() / 1e6), "chars": len(text), "temperature": temperature,
                 "lang": lang, "spoken_text": text if text != req["text"] else None}
        self.served += 1
        if cancelled:
            self._reset_decoder()
            t_c = self._cancel_received_at(req)
            if t_c is not None:
                stats["cancel_latency_ms"] = ms(time.monotonic() - t_c)
            emit({"type": "cancelled", "id": rid, "generation": gen, "final": True, "stats": stats})
            return
        if stream:
            emit({"type": "end", "id": rid, "generation": gen, "seq": seq, "final": True, "stats": stats})
            return
        pcm = b"".join(acc)
        if fmt == "wav":
            hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE" + b"fmt " + \
                struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
            emit({"type": "chunk", "id": rid, "generation": gen, "seq": 0, "final": True, "sr": SR,
                  "samples": len(pcm) // 2, "wav": base64.b64encode(hdr + pcm).decode("ascii"), "stats": stats})
        else:
            emit({"type": "chunk", "id": rid, "generation": gen, "seq": 0, "final": True, "sr": SR,
                  "samples": len(pcm) // 2, "pcm16": base64.b64encode(pcm).decode("ascii"), "stats": stats})

    def _reset_decoder(self):
        try:
            if self.model is not None:
                self.model.speech_tokenizer.decoder.reset_streaming_state()
            if self.mx is not None:
                self.mx.clear_cache()
        except Exception as e:  # noqa: BLE001
            log("decoder reset failed: " + str(e))

    def warmup(self, req):
        t = time.monotonic()
        load_s = self.ensure_loaded()
        self.cancel_event.clear()
        t1 = time.monotonic()
        kw, _ = self._resolve_voice({"voice": req.get("voice") or ("ryan" if self.kind == "custom_voice" else ""),
                                      "instruct": "Calm." if self.kind == "voice_design" else None})
        if kw is not None:
            g = self.model.generate(text="Hi there.", stream=True, streaming_interval=self.args.interval,
                                    max_tokens=40, lang_code="english", **kw)
            for _ in g:
                pass
        self.mx.clear_cache()
        self.last_used = time.monotonic()
        emit({"type": "warm", "id": req.get("id"), "final": True, "model": self.model_name, "kind": self.kind,
              "load_ms": ms(load_s), "warm_ms": ms(time.monotonic() - t1), "total_ms": ms(time.monotonic() - t)})

    # ---- introspection (reader thread; never touches the model) ----------
    def health(self, req):
        with self.cv:
            depth = len(self.q)
        cur = self.current
        mem = footprint() or {}
        if self.mx is not None:
            mem.update({"mlx_active_mb": round(self.mx.get_active_memory() / 1e6),
                        "mlx_cache_mb": round(self.mx.get_cache_memory() / 1e6)})
        emit({"type": "health", "id": req.get("id"), "final": True, "state": self.state, "model": self.model_name,
              "kind": self.kind, "loaded": self.model is not None, "queue": depth,
              "current": {"id": cur.get("id"), "generation": cur.get("generation")} if cur else None,
              "cancel_upto": self.cancel_upto, "served": self.served, "uptime_s": round(time.monotonic() - T_START, 1),
              "idle_s": round(time.monotonic() - self.last_used, 1), "mem": mem, "pressure": pressure_level(), "pid": os.getpid()})

    def voices(self, req):
        kind, spk = self.kind, None
        try:
            cfg = json.load(open(os.path.join(self._model_dir(), "config.json"), encoding="utf-8"))
            kind = cfg.get("tts_model_type", kind)
            spk = list((cfg.get("talker_config") or {}).get("spk_id") or {})
        except Exception:  # noqa: BLE001
            pass
        speakers = [{"id": s, "gender": SPEAKERS.get(s, ("?",))[0], "native": SPEAKERS.get(s, ("?", "?"))[1],
                     "description": SPEAKERS.get(s, ("?", "?", ""))[2]} for s in (spk or [])] if kind == "custom_voice" else []
        clones, designs = [], []
        if self.voices_dir and os.path.isdir(self.voices_dir):
            for f in sorted(os.listdir(self.voices_dir)):
                if f.endswith(".design.txt"):
                    designs.append(f[: -len(".design.txt")])
                elif f.endswith(".wav"):
                    clones.append(f[:-4])
        emit({"type": "voices", "id": req.get("id"), "final": True, "model": self.model_name, "kind": kind,
              "speakers": speakers, "clones": ["clone:" + c for c in clones] if kind == "base" else [],
              "designs": ["design:" + d for d in designs] if kind == "voice_design" else [],
              "capabilities": {"instruct": kind in ("custom_voice", "voice_design"), "stream": True,
                               "speed": "client", "sample_rate": SR, "formats": ["pcm16", "wav"],
                               "max_chars": MAX_CHARS}})

    # ---- loops -----------------------------------------------------------
    def reader(self):
        # Bytes, not sys.stdin's text iterator: a line with invalid UTF-8 used to raise out
        # of the loop and kill the process. Every line is handled under a catch-all so a
        # malformed request is answered with a coded error and the sidecar keeps serving.
        for raw in sys.stdin.buffer:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                if self.handle(line) == "shutdown":
                    break
            except Exception as e:  # noqa: BLE001
                log("bad request: " + traceback.format_exc())
                emit({"type": "error", "id": None, "code": "bad_request", "message": str(e)[:200], "final": True})
        # stdin closed (Redline quit or killed the pipe) or shutdown requested
        self.shutdown = True
        self._apply_cancel(everything=True)
        with self.cv:
            self.cv.notify()

    def _validate_speak(self, req):
        """-> error code or None; stores the cleaned text and numeric params on req."""
        text = req.get("text")
        if not isinstance(text, str) or not text.strip():
            return "empty_text", "text must be a non-empty string"
        if len(text) > MAX_CHARS:
            return "text_too_long", f"{len(text)} chars > {MAX_CHARS}"
        for k in ("voice", "instruct", "description", "lang", "format"):
            if req.get(k) is not None and not isinstance(req.get(k), str):
                return f"bad_{k}", f"{k} must be a string"
        if req.get("lang") is not None and req["lang"].lower() not in LANGS:
            return "bad_lang", f"lang must be one of {sorted(LANGS)}"
        if req.get("lang"):
            req["lang"] = req["lang"].lower()
        if req.get("format") is not None and req["format"] not in FORMATS:
            return "bad_format", "format must be pcm16 or wav"
        seed = req.get("seed")
        if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2 ** 32):
            return "bad_seed", "seed must be an integer in [0, 2^32)"
        nums = {}
        for k, lo, hi, dflt in (("interval", 0.08, 2.0, self.args.interval), ("temperature", 0.1, 1.2, self.args.temperature)):
            v = req.get(k)
            if v is None:
                nums[k] = dflt
            elif isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
                return "bad_param", f"{k} must be a finite number"
            else:
                nums[k] = min(hi, max(lo, float(v)))
        clean = clean_text(text, normalize=req.get("normalize", True) is not False)
        if not clean or not speakable(clean):
            return "empty_text", "nothing speakable after cleanup (markup, emoji, code or an unsupported script only)"
        req["_clean"], req["_interval"], req["_temperature"] = clean, nums["interval"], nums["temperature"]
        return None

    def handle(self, line):
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "id": None, "code": "bad_json", "message": str(e)[:200], "final": True})
            return None
        if not isinstance(req, dict):
            emit({"type": "error", "id": None, "code": "bad_request", "message": "expected a JSON object", "final": True})
            return None
        rid = req.get("id")
        if not _json_id(rid):
            emit({"type": "error", "id": None, "code": "bad_id", "message": "id must be a string or an integer", "final": True})
            return None
        op = req.get("op") or ("speak" if "text" in req else None)
        gen = req.get("generation")
        if gen is not None and (not isinstance(gen, int) or isinstance(gen, bool)):
            emit({"type": "error", "id": rid, "code": "bad_generation", "message": "generation must be an integer", "final": True})
            return None
        if op == "cancel":
            target = req.get("target")
            if not _json_id(target):
                emit({"type": "error", "id": None, "code": "bad_id", "message": "target must be a string or an integer", "final": True})
                return None
            target = target if target is not None else (rid if gen is None and not req.get("all") else None)
            if gen is None and target is None and not req.get("all"):
                emit({"type": "error", "id": None, "code": "bad_cancel", "message": "cancel needs generation, id/target or all", "final": True})
                return None
            self._apply_cancel(generation=gen, rid=target, everything=bool(req.get("all")))
            return None
        if op == "health":
            self.health(req)
            return None
        if op == "voices":
            self.voices(req)
            return None
        if op == "shutdown":
            return "shutdown"
        if op == "speak":
            err = self._validate_speak(req)
            if err:
                emit({"type": "error", "id": rid, "generation": gen, "code": err[0], "message": err[1], "final": True})
                return None
            older = None
            with self.lock:
                if gen is not None:
                    older = self.max_generation
                    self.max_generation = gen if older is None else max(older, gen)
                stale = self._stale(req)
            if stale:
                emit({"type": "cancelled", "id": rid, "generation": gen, "final": True, "stats": {"stage": "arrival"}})
                return None
            if gen is not None and req.get("supersede", True) and older is not None and gen > older:
                # A newer generation means the conversation moved on: drop older audio.
                self._apply_cancel(generation=gen - 1)
        elif op in ("warmup", "unload", "load"):
            if req.get("voice") is not None and not isinstance(req.get("voice"), str):
                emit({"type": "error", "id": rid, "code": "bad_voice", "message": "voice must be a string", "final": True})
                return None
            if op == "load" and not isinstance(req.get("model"), str):
                emit({"type": "error", "id": rid, "code": "model_missing", "message": f"no model {req.get('model')!r}", "final": True})
                return None
        else:
            emit({"type": "error", "id": rid, "generation": gen, "code": "unknown_op", "message": f"unknown op {op!r}"[:200], "final": True})
            return None
        req["op"] = op
        req["_t_enq"] = time.monotonic()
        with self.cv:
            self.q.append(req)
            self.cv.notify()
        return None

    def _idle_housekeeping(self):
        """Called by the worker while idle: unload on critical memory pressure (the OS is
        about to start killing apps; 3+ GB of weights is the cheapest thing to give back),
        drop MLX's buffer cache on a warning."""
        if not self.args.pressure_unload or self.model is None:
            return
        lvl = pressure_level()
        if lvl is not None and lvl >= 4:
            self.unload("memory_pressure")
        elif lvl == 2 and self.mx is not None and self.mx.get_cache_memory() > 0:
            self.mx.clear_cache()

    def worker(self):
        try:
            self._worker_loop()
        except BaseException as e:  # noqa: BLE001
            # A dead worker would leave every later request queued forever (a hang Redline
            # cannot tell from a slow synthesis). Exit instead: Redline sees EOF and falls back.
            log("worker crashed: " + traceback.format_exc())
            try:
                emit({"type": "fatal", "id": None, "code": "worker_crashed", "message": str(e)[:200], "final": True})
            finally:
                os._exit(70)

    def _worker_loop(self):
        idle = self.args.idle_unload_s
        while True:
            with self.cv:
                while not self.q and not self.shutdown:
                    timeout = None
                    if self.model is not None:
                        if idle > 0:
                            timeout = max(0.5, idle - (time.monotonic() - self.last_used))
                        if self.args.pressure_unload:
                            timeout = 2.0 if timeout is None else min(timeout, 2.0)
                    self.cv.wait(timeout=timeout)
                    if not self.q and not self.shutdown:
                        if idle > 0 and self.model is not None and time.monotonic() - self.last_used >= idle:
                            break
                        if timeout is not None:
                            self.cv.release()
                            try:
                                self._idle_housekeeping()
                            finally:
                                self.cv.acquire()
                if self.shutdown:
                    return
                req = self.q.popleft() if self.q else None
            if req is None:
                self.unload("idle")
                continue
            op = req["op"]
            try:
                if op == "speak":
                    if self._stale(req):
                        emit({"type": "cancelled", "id": req.get("id"), "generation": req.get("generation"), "final": True,
                              "stats": {"stage": "queued"}})
                        continue
                    self.speak(req)
                elif op == "warmup":
                    self.warmup(req)
                elif op == "unload":
                    dt = self.unload("request")
                    emit({"type": "unloaded", "id": req.get("id"), "final": True, "unload_ms": ms(dt), "mem": footprint()})
                elif op == "load":
                    name = req.get("model")
                    if not isinstance(name, str) or not os.path.isdir(self._model_dir(name)):
                        emit({"type": "error", "id": req.get("id"), "code": "model_missing", "message": f"no model {name!r}", "final": True})
                        continue
                    if name != self.model_name:
                        self.unload("switch")
                        self.model_name = name
                    dt = self.ensure_loaded()
                    emit({"type": "loaded", "id": req.get("id"), "final": True, "model": name, "kind": self.kind, "load_ms": ms(dt)})
            except Exception as e:  # noqa: BLE001
                log("op failed: " + traceback.format_exc())
                self.state = "ready" if self.model is not None else "cold"
                with self.lock:
                    self.current = None
                emit({"type": "error", "id": req.get("id"), "generation": req.get("generation"), "code": f"{op}_failed",
                      "message": str(e)[:300], "final": True})


def main():
    ap = argparse.ArgumentParser(description="Redline studio-voice sidecar (Qwen3-TTS on MLX)")
    ap.add_argument("--models-root", required=True, help="directory holding model directories")
    ap.add_argument("--model", required=True, help="model directory name under --models-root")
    ap.add_argument("--voices-dir", default=None, help="consented clone references (<id>.wav + <id>.txt) and designs")
    ap.add_argument("--preload", action="store_true", help="load + warm the model at startup")
    ap.add_argument("--interval", type=float, default=0.32, help="seconds of audio per streamed chunk")
    ap.add_argument("--temperature", type=float, default=0.7, help="sampling temperature (0.9 = mlx-audio default; 0.7 measured safer)")
    ap.add_argument("--cache-limit-mb", type=int, default=512, help="MLX buffer cache cap (-1 = MLX default)")
    ap.add_argument("--memory-limit-mb", type=int, default=0, help="MLX memory limit (0 = MLX default)")
    ap.add_argument("--idle-unload-s", type=float, default=0, help="unload the model after this idle time (0 = never)")
    ap.add_argument("--chunk-cancel-only", action="store_true", help="disable the per-frame cancel hook")
    ap.add_argument("--xvector-only", action="store_true", help="clone from the speaker embedding only (no transcript)")
    ap.add_argument("--no-pressure-unload", dest="pressure_unload", action="store_false",
                    help="do not unload the model when macOS reports critical memory pressure")
    args = ap.parse_args()

    # SIGINT: Python turns it into KeyboardInterrupt in the MAIN thread, but macOS may deliver
    # a process signal to any thread (MLX/Metal or the worker). The main thread then stays
    # blocked reading stdin and the sidecar never exits (seen in testing). The default action
    # terminates the process from whichever thread receives it; there is nothing to clean up.
    import signal
    signal.signal(signal.SIGINT, signal.SIG_DFL)

    sc = Sidecar(args)
    versions = {"python": sys.version.split()[0]}
    try:
        from importlib.metadata import version
        for p in ("mlx", "mlx-audio", "transformers"):
            versions[p] = version(p)
    except Exception:  # noqa: BLE001
        pass
    emit({"type": "hello", "protocol": PROTOCOL, "engine": "qwen3-tts-mlx", "pid": os.getpid(), "model": args.model,
          "versions": versions, "sample_rate": SR, "ops": ["speak", "cancel", "warmup", "unload", "load", "health", "voices", "shutdown"]})
    if args.preload:
        with sc.cv:
            sc.q.append({"op": "warmup", "id": "preload", "_t_enq": time.monotonic()})
    w = threading.Thread(target=sc.worker, name="synth", daemon=True)
    w.start()
    try:
        sc.reader()
    except KeyboardInterrupt:
        pass
    w.join(timeout=2.0)
    os._exit(0)


if __name__ == "__main__":
    main()
