# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Yusuf Al-Bazian
"""Redline's end-of-turn scorer: has the speaker finished?

Smart Turn v3 (BSD-2-Clause, Daily; a Whisper-tiny encoder with a linear head,
int8 ONNX) on the last 8 s of the user's audio. Run by turn_scorer.rs on the
Kokoro runtime's interpreter, which already has numpy and onnxruntime:

    python -I -B turn_scorer.py <model.onnx>

Protocol: once loaded it prints `ready` (or `error <why>`). Then each request
is a line `<id> <samples>` followed by that many 16 kHz mono samples as
little-endian int16, answered by one line `<id> <probability>` (`nan` when it
could not score).

The input features are Whisper's 80-bin log-mel spectrogram over an 8 s window,
computed here in numpy exactly as the model's reference code computes them
with the transformers feature extractor (zero-padded at the start, normalized
to zero mean and unit variance, n_fft 400, hop 160, slaney mel to 8 kHz), so
transformers is not needed.
"""

import sys

import numpy as np
import onnxruntime as ort

SR = 16000
WINDOW = 8 * SR
N_FFT = 400
HOP = 160
MELS = 80


def mel_filters():
    def to_mel(f):
        log_part = 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) / (np.log(6.4) / 27.0)
        return np.where(f >= 1000.0, log_part, f * 3.0 / 200.0)

    def to_hz(m):
        return np.where(m >= 15.0, 1000.0 * np.exp(np.log(6.4) / 27.0 * (m - 15.0)), m * 200.0 / 3.0)

    fft_freqs = np.linspace(0, SR // 2, N_FFT // 2 + 1)
    edges = to_hz(np.linspace(to_mel(0.0), to_mel(8000.0), MELS + 2))
    slopes = edges[None, :] - fft_freqs[:, None]
    down = -slopes[:, :-2] / np.diff(edges)[:-1]
    up = slopes[:, 2:] / np.diff(edges)[1:]
    bank = np.maximum(0.0, np.minimum(down, up))
    return bank * (2.0 / (edges[2:] - edges[:-2]))[None, :]


FILTERS = mel_filters()
HANN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)


def features(audio):
    x = audio[-WINDOW:].astype(np.float64)
    x = np.pad(x, (WINDOW - len(x), 0))
    x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    x = np.pad(x, N_FFT // 2, mode="reflect")
    frames = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    power = np.abs(np.fft.rfft(x[idx] * HANN, axis=1)) ** 2
    log = np.log10(np.maximum(power @ FILTERS, 1e-10)).T[:, :-1]
    log = np.maximum(log, log.max() - 8.0)
    return ((log + 4.0) / 4.0)[None].astype(np.float32)


def main():
    out = sys.stdout
    try:
        opts = ort.SessionOptions()
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.inter_op_num_threads = 1
        # Four threads answer in ~13 ms (p95) without crowding a voice being
        # synthesized beside it; two take ~22 ms.
        opts.intra_op_num_threads = 4
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(sys.argv[1], sess_options=opts, providers=["CPUExecutionProvider"])
        session.run(None, {"input_features": features(np.zeros(SR, np.float32))})
    except Exception as e:  # noqa: BLE001 - reported to Redline, which falls back
        out.write(f"error {e}\n")
        out.flush()
        return
    out.write("ready\n")
    out.flush()
    stdin = sys.stdin.buffer
    while True:
        head = stdin.readline().split()
        if len(head) != 2:
            return
        rid, n = head[0].decode(), int(head[1])
        raw = stdin.read(2 * n)
        if len(raw) < 2 * n:
            return
        try:
            pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            p = float(session.run(None, {"input_features": features(pcm)})[0].reshape(-1)[0])
            out.write(f"{rid} {p:.4f}\n")
        except Exception:  # noqa: BLE001 - one bad request is not the process's end
            out.write(f"{rid} nan\n")
        out.flush()


if __name__ == "__main__":
    main()
