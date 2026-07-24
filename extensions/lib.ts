/**
 * pi-openai-codex-image helpers.
 *
 * Thin facade over `pi-image-core`: Codex/ChatGPT-OAuth-specific config + a
 * model-resolution wrapper, with everything else re-exported. The OAuth
 * token resolution (with refresh), the HTTP wrapper, upload persistence, and
 * override-file logic all live in core, shared with the other pi-*-image
 * extensions.
 */

import { resolveModel as resolveModelCore, OPENAI_CODEX_IMAGE_MODELS } from "pi-image-core";

export {
	OUTPUT_URL_PREFIX,
	ensureOutputDir,
	extFromOutputFormat,
	getOpenAICodexAuth,
	resolveFormat,
	resolveInputImageUrl,
	resolveOutputDir,
	writeBase64,
} from "pi-image-core";
export {
	callOpenAICodexImage,
	CODEX_IMAGE_EDITS_ENDPOINT,
	CODEX_IMAGE_GENERATIONS_ENDPOINT,
} from "pi-image-core";
export type { ImageModelEntry, OpenAICodexAuth, OpenAICodexImageResponse } from "pi-image-core";
export {
	OPENAI_CODEX_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	OPENAI_CODEX_MAX_RETRIES as MAX_RETRIES,
} from "pi-image-core";

/** Codex model catalog (re-exported under the legacy name `IMAGE_MODELS`). */
export const IMAGE_MODELS = OPENAI_CODEX_IMAGE_MODELS;

/** Upstream Codex's built-in imagegen tool fixes this model. The backend may
 *  return metadata like `gpt-image-2-codex`, `quality:auto`, `size:auto`. */
export const DEFAULT_MODEL = "gpt-image-2";

/** Order: explicit param > override file (honour `openai-codex/`, fall through
 *  on other backends) > OPENAI_CODEX_IMAGE_MODEL env > DEFAULT_MODEL. */
export function resolveModel(explicit?: string | null | undefined): string {
	return resolveModelCore({
		explicit,
		ownSource: "openai-codex",
		envVar: "OPENAI_CODEX_IMAGE_MODEL",
		defaultModel: DEFAULT_MODEL,
	});
}
