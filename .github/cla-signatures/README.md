# CLA signatures

Contributor CLA signatures are recorded by the CLA Assistant Lite GitHub Action
(`.github/workflows/cla.yml`) into `v1.json` on the dedicated **`cla-signatures`**
branch of this repository — not on `main`. This keeps the signature record in our own
repo with no third-party data custody.

## Setup notes (maintainer)

No secret is required: signatures are stored in this same repository, so the
workflow's built-in `GITHUB_TOKEN` (with the `contents: write` permission declared
in `cla.yml`) is sufficient. A `PERSONAL_ACCESS_TOKEN` Actions secret would only be
needed if signatures were ever moved to a remote repository.

The `cla-signatures` branch and `v1.json` are created automatically on the first
pull request.

The legally operative agreement text is [`/CLA.md`](../../CLA.md).
