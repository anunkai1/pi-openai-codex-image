# pi-openai-codex-image

OpenAI GPT image generation for the [pi coding agent](https://github.com/badlogic/pi-mono), authenticated through the user's existing **OpenAI Codex / ChatGPT OAuth** login.

It uses the same Codex backend as upstream Codex's built-in `image_gen` tool:

- `POST https://chatgpt.com/backend-api/codex/images/generations`
- `POST https://chatgpt.com/backend-api/codex/images/edits`

This is intentionally **not** the public OpenAI Platform `/v1/images` API, so it does not require an `OPENAI_API_KEY`.

## Tools

- `openai_codex_generate_image` — single image generation or img2img edit through optional `input_image`.

It saves returned base64 data to `ACB_UPLOADS_DIR` (or `<cwd>/uploads`) and return browser-renderable `/uploads/<uuid>.<ext>` URLs.

## Authentication

Pi's normal OpenAI Codex OAuth login stores credentials in:

```text
~/.pi/agent/auth.json → openai-codex
```

The extension prefers that entry. If absent, it reuses the existing **Codex CLI subscription login** at `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). Run `codex login` if neither exists. No API key is required.

Credentials are read at call time and refreshed in their original store, preserving symlinks into a central secrets store. CLI refresh tokens are **not copied into Pi's store**, because they rotate and two independent copies would diverge.

Pi's separate `openai` **subscription-sharing** login is for text models. OpenAI currently rejects image generation through it (`subscription_sharing_unsupported_capability`); it is not interchangeable with the Codex login.

## Install

```sh
pi install /path/to/pi-openai-codex-image
```

For ACB's unified image picker, load this package alongside `pi-local-image` in `~/.pi/agent/settings.json`. The shared `pi-image-core` catalogue already supplies **GPT Image 2 (Codex/ChatGPT OAuth)**, stored as `openai-codex/gpt-image-2` when selected.

## Model controls

The upstream Codex implementation uses `gpt-image-2`; this extension exposes that as its current catalog model. The service may normalize request metadata (for example to `gpt-image-2-codex`, `quality: auto`, or `size: auto`), so response metadata is treated as authoritative.

## Tests

```sh
npm test
```
