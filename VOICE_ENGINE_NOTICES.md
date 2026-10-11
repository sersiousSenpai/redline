# Voice engine notices

Redline's local voices, its local dictation polish and its end-of-turn model
run in separate processes. They use a private Python environment that
Redline downloads into its app data folder the first time you turn one on.
None of it is part of the Redline binary or its source: Redline only
exchanges text and audio with those processes over a pipe. This file credits
what is downloaded and gives each part's license.

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
- **mlx-lm**, by Apple: MIT. It runs the local dictation polish below.
- **onnxruntime**, by Microsoft: MIT. It runs the end-of-turn model below
  where Kokoro isn't installed.

### Python packages

These are the exact versions pinned in
`src-tauri/resources/studio-requirements.lock`.

| Package | License |
|---|---|
| numpy | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| scipy | BSD-3-Clause; see the note below |
| transformers, tokenizers, huggingface-hub, safetensors, hf-xet, flatbuffers | Apache-2.0 |
| regex | Apache-2.0 AND CNRI-Python |
| packaging | Apache-2.0 OR BSD-2-Clause |
| tqdm | MPL-2.0 AND MIT |
| typing-extensions | PSF-2.0 |
| click, fsspec, httpcore2, httpx2, idna, jinja2, markupsafe, protobuf | BSD-3-Clause |
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

## Local dictation polish (Qwen3.5)

Installed into `<app data>/voice-studio/models/polish/` from the Dictation
section of Voice settings, whatever the speaking engine, and run in the
studio voice's sidecar on the same runtime. It needs that runtime (installed
with it when missing), not the voice's model.

- **Qwen3.5-2B**, by the Qwen team at Alibaba Cloud: Apache-2.0. The
  Apache License 2.0 text is in [LICENSE](LICENSE).
- **MLX conversion by mlx-community**: Apache-2.0. Redline downloads
  `mlx-community/Qwen3.5-2B-4bit` at
  `674aaa7240b91e8012fcad5d791b7dfe5ba90207`, pinned by each file's SHA-256.
- It runs through mlx-lm, with Jinja2 and MarkupSafe for its chat template,
  all listed with the studio voice's runtime above.

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
- The end-of-turn model below runs on this runtime's numpy and onnxruntime
  when it is installed.

## End-of-turn model (Smart Turn)

Downloaded into `<app data>/turn/` from Voice settings (End of turn), and run
in a process of its own on the Kokoro runtime, else the studio voice's.

- **Smart Turn v3.1**, by Daily: BSD-2-Clause. Redline downloads
  `smart-turn-v3.1-cpu.onnx` (8,679,180 bytes) from the Hugging Face repository
  `pipecat-ai/smart-turn-v3` at `f766f81d3cfdf7737ac64aad813d91bbfd56bf93`,
  pinned by its SHA-256
  (`fb68d55c2d542ce79e44b12013bfd571e90df8594ab096d757198e851b0c6594`).
- It runs through **onnxruntime** (MIT) and **numpy**, listed with each
  runtime above. Its script ships inside Redline, under Redline's license.
