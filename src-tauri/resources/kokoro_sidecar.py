#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Yusuf Al-Bazian
#
# Redline Kokoro TTS sidecar. A tiny, long-lived helper process that loads the
# Kokoro-82M ONNX model once and then synthesizes one WAV clip per request. It
# speaks a line-delimited JSON protocol on stdio:
#
#   stdin  : one JSON object per line  -> {"text": "...", "voice": "af_sarah", "speed": 1.0}
#   stdout : one JSON object per line  -> {"ready": true}          (once, at startup)
#                                         {"audio": "<base64 wav>"} (per request)
#                                         {"error": "..."}          (startup or per request)
#
# It runs as a SEPARATE PROCESS on purpose: kokoro-onnx pulls in a GPL
# phonemizer (espeak-ng via misaki), and keeping it at arm's length over a pipe
# means that GPL code never links into Redline's Apache-2.0 binary. Redline
# manages this process' lifecycle and only ever exchanges text and audio bytes.

import sys
import json
import base64
import struct


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write("[kokoro-sidecar] " + str(msg) + "\n")
    sys.stderr.flush()


def to_wav(samples, sample_rate):
    """Encode a mono float32 array in [-1, 1] as a 16-bit PCM WAV (bytes)."""
    import numpy as np

    pcm = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2").tobytes()
    n = len(pcm)
    header = b"RIFF" + struct.pack("<I", 36 + n) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, int(sample_rate), int(sample_rate) * 2, 2, 16
    )
    header += b"data" + struct.pack("<I", n)
    return header + pcm


def main():
    if len(sys.argv) < 3:
        emit({"error": "usage: kokoro_sidecar.py <model.onnx> <voices.bin>"})
        return
    model_path, voices_path = sys.argv[1], sys.argv[2]

    try:
        from kokoro_onnx import Kokoro
    except Exception as e:  # noqa: BLE001 - report any import failure verbatim
        emit({"error": "kokoro-onnx not installed: " + str(e)})
        return

    try:
        kokoro = Kokoro(model_path, voices_path)
    except Exception as e:  # noqa: BLE001
        emit({"error": "failed to load Kokoro model: " + str(e)})
        return

    # Handshake: tells Redline the model is loaded and we're ready for requests.
    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            emit({"error": "bad request: " + str(e)})
            continue

        text = (req.get("text") or "").strip()
        voice = req.get("voice") or "af_sarah"
        try:
            speed = float(req.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        if not text:
            emit({"error": "empty text"})
            continue

        try:
            samples, sample_rate = kokoro.create(
                text, voice=voice, speed=speed, lang="en-us"
            )
            wav = to_wav(samples, sample_rate)
            emit({"audio": base64.b64encode(wav).decode("ascii")})
        except Exception as e:  # noqa: BLE001
            log("synth failed: " + str(e))
            emit({"error": str(e)})


if __name__ == "__main__":
    main()
