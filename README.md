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

The extension reads the current access token and `accountId`, refreshes OAuth tokens when needed, and persists the refreshed token back to that same file. Run Pi's OpenAI/Codex login flow first if the entry is absent.

## Install

```sh
pi install /path/to/pi-openai-codex-image
```

For ACB's unified image picker, also add the package to `~/.pi/agent/settings.json` and add `openai-codex/<model>` to the picker catalog owned by `pi-local-image`.

## Model controls

The upstream Codex implementation uses `gpt-image-2`; this extension exposes that as its current catalog model. The service may normalize request metadata (for example to `gpt-image-2-codex`, `quality: auto`, or `size: auto`), so response metadata is treated as authoritative.

## Tests

```sh
npm test
```
