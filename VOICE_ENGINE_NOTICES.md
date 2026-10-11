# Voice engine notices

Redline's local voices run in a separate process. They use a private Python
environment that Redline downloads into its app data folder the first time
you turn one on. None of it is part of the Redline binary or its source:
Redline only exchanges text and audio with that process over a pipe. This
file credits what is downloaded and gives each part's license.

## Studio voice (Qwen3-TTS)

Installed into `<app data>/voice-studio/` from Voice settings.

The settings card credits it in one line:

> Studio voice uses Qwen3-TTS by the Qwen team (Alibaba Cloud, Apache-2.0),
> running on MLX.

### Model

- **Qwen3-TTS-12Hz-1.7B-CustomVoice**, by the Qwen team at Alibaba Cloud:
  Apache-2.0. The Apache License 2.0 text is in [LICENSE](LICENSE).
- **MLX conversions by mlx-community**: Apache-2.0. Redline downloads them
  pinned by revision and by each file's SHA-256:
  - `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` at
    `41d3337e8b7f2843a75841595fc14e4b9a7a4b96` (the default);
  - `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit` at
    `f35faf19b0cc2160865af64ecf0f22f83d335135` (the low-memory choice).

### Runtime

- **CPython 3.12**, from python-build-standalone: PSF-2.0. The build links
  libedit (BSD), OpenSSL (Apache-2.0) and SQLite (public domain).
- **uv**, by Astral: Apache-2.0 OR MIT. It is used only to install.
- **MLX** and **mlx-metal**, by Apple: MIT.
- **mlx-audio**: MIT.

### Python packages

These are the exact versions pinned in
`src-tauri/resources/studio-requirements.lock`.

| Package | License |
|---|---|
| numpy | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| scipy | BSD-3-Clause; see the note below |
| transformers, tokenizers, huggingface-hub, safetensors, hf-xet | Apache-2.0 |
| regex | Apache-2.0 AND CNRI-Python |
| packaging | Apache-2.0 OR BSD-2-Clause |
| tqdm | MPL-2.0 AND MIT |
| typing-extensions | PSF-2.0 |
| click, fsspec, httpcore2, httpx2, idna | BSD-3-Clause |
| pygments | BSD-2-Clause |
| shellingham | ISC |
| annotated-doc, anyio, filelock, h11, markdown-it-py, mdurl, pyyaml, rich, truststore, typer | MIT |

**scipy's runtime libraries.** scipy's macOS wheel ships three dynamically
linked libraries:

- the GCC runtime libraries `libgfortran` and `libgcc_s`, under
  GPL-3.0-or-later WITH GCC-exception-3.1;
- `libquadmath`, under LGPL-2.1-or-later.

They are downloaded as scipy publishes them, into the private environment,
apart from Redline.

## Natural voice (Kokoro)

Installed into `<app data>/kokoro/` from Voice settings.

- **Kokoro-82M**, by hexgrad: Apache-2.0.
- **kokoro-onnx**: MIT.
- **onnxruntime**, by Microsoft: MIT.
- **numpy**: BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0.
- **phonemizer-fork** and the **espeak-ng** library bundled by
  espeakng-loader: GPL-3.0-or-later. This is why Kokoro runs as a separate
  process and never links into Redline.
- The same **CPython** and **uv** as above. Installs made before 2026-10-10
  used a CPython in `~/.local/share/uv`, which Redline leaves where it is.
