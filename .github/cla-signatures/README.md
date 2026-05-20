# CLA signatures

Contributor CLA signatures are recorded by the CLA Assistant Lite GitHub Action
(`.github/workflows/cla.yml`) into `v1.json` on the dedicated **`cla-signatures`**
branch of this repository — not on `main`. This keeps the signature record in our own
repo with no third-party data custody.

## One-time setup (maintainer)

1. Create a repo-scoped Personal Access Token (classic `repo`, or fine-grained with
   Contents: read/write on this repo).
2. Add it as a repository (or organization) Actions secret named
   `PERSONAL_ACCESS_TOKEN`.
3. The `cla-signatures` branch and `v1.json` are created automatically on the first
   pull request.

The legally operative agreement text is [`/CLA.md`](../../CLA.md).
