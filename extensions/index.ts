/** pi-openai-codex-image — OpenAI GPT image generation via Codex/ChatGPT OAuth.
 *
 * Uses the same OAuth-backed backend upstream Codex's built-in image_gen tool
 * uses (`chatgpt.com/backend-api/codex/images/...`). This is NOT the public
 * OpenAI Platform /v1/images API and does NOT require OPENAI_API_KEY; it uses
 * ~/.pi/agent/auth.json's `openai-codex` OAuth entry.
 */

import Type from "typebox";
import {
	callOpenAICodexImage,
	ensureOutputDir,
	extFromOutputFormat,
	getOpenAICodexAuth,
	resolveFormat,
	resolveInputImageUrl,
	resolveModel,
	resolveOutputDir,
	writeBase64,
	type OpenAICodexImageResponse,
} from "./lib.js";

const ImageGenerateParams = Type.Object({
	prompt: Type.String({ description: "Text description of the image to generate or edit." }),
	model: Type.Optional(Type.String({ description: "Override model. Default and only picker model is gpt-image-2 (Codex/ChatGPT OAuth image path)." })),
	input_image: Type.Optional(Type.String({ description: "Optional reference/edit image for img2img. Accepted: local file path, /uploads/<file>, http(s) URL, or data: URL." })),
	size: Type.Optional(Type.String({ description: "Size hint, e.g. 'auto', '1024x1024', '1536x1024', '1024x1536'. Codex may normalize to auto/gpt-image-2-codex." })),
	quality: Type.Optional(Type.String({ description: "Quality hint: 'auto', 'low', 'medium', or 'high'. Codex may normalize to auto." })),
	background: Type.Optional(Type.String({ description: "Background hint: 'auto', 'opaque', or 'transparent'. Codex built-in defaults to auto." })),
	format: Type.Optional(Type.String({ description: "Output format hint: 'png', 'jpeg', or 'webp'. Default png; response output_format is authoritative when present." })),
});

function buildBody(opts: {
	model: string;
	prompt: string;
	formatId: string;
	size?: string;
	quality?: string;
	background?: string;
	inputImageUrl?: string;
}): { kind: "generate" | "edit"; body: Record<string, unknown> } {
	const body: Record<string, unknown> = {
		prompt: opts.prompt,
		model: opts.model,
		background: opts.background && opts.background.length > 0 ? opts.background : "auto",
		quality: opts.quality && opts.quality.length > 0 ? opts.quality : "auto",
		size: opts.size && opts.size.length > 0 ? opts.size : "auto",
		output_format: opts.formatId,
	};
	if (opts.inputImageUrl) {
		body.images = [{ image_url: opts.inputImageUrl }];
		return { kind: "edit", body };
	}
	return { kind: "generate", body };
}

async function persistFirst(resp: OpenAICodexImageResponse, outputDir: string, fallbackExt: string): Promise<string | null> {
	const b64 = resp.data?.find((x) => typeof x.b64_json === "string" && x.b64_json.length > 0)?.b64_json;
	if (!b64) return null;
	const ext = extFromOutputFormat(resp.output_format, fallbackExt);
	return writeBase64(b64, outputDir, ext);
}

async function formatResult(prompt: string, model: string, resp: OpenAICodexImageResponse, outputDir: string, fallbackExt: string) {
	const url = await persistFirst(resp, outputDir, fallbackExt);
	const meta = [resp.size, resp.quality ? `quality ${resp.quality}` : null, resp.background ? `background ${resp.background}` : null]
		.filter(Boolean)
		.join(", ");
	if (!url) {
		return {
			content: [{ type: "text" as const, text: `OpenAI Codex returned no decodable image for model '${model}' and prompt "${prompt.slice(0, 200)}".` }],
			details: { model, images: [], response: resp },
		};
	}
	const lines = [
		`Generated 1 image with **${model}** via OpenAI Codex OAuth${meta ? ` (${meta})` : ""}:`,
		"",
		`![generated image](${url})`,
		"",
		"URLs:",
		`- ${url}`,
	];
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { model, images: [url], response: resp },
	};
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "openai_codex_generate_image",
		label: "OpenAI Codex: Generate Image",
		description:
			"Generate or edit an image using OpenAI GPT image generation through Codex/ChatGPT OAuth (the same backend as upstream Codex's built-in image_gen tool). Does NOT require OPENAI_API_KEY; uses ~/.pi/agent/auth.json's openai-codex OAuth token. Supports img2img via input_image. Returns /uploads/<uuid> URLs. Note: Codex may normalize size/quality/model (e.g. gpt-image-2-codex, quality auto, size auto).",
		promptSnippet:
			"Use when the active image model is an OpenAI Codex/ChatGPT OAuth model (source tag openai-codex/) or the user specifically wants GPT images via ChatGPT/Codex OAuth. Supports img2img via input_image. For OpenRouter-hosted OpenAI image models use openrouter_generate_image instead.",
		parameters: ImageGenerateParams,
		async execute(_callId, params, signal) {
			let auth;
			try { auth = await getOpenAICodexAuth(); } catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error resolving OpenAI Codex OAuth: ${msg}` }], details: { error: msg, model: null, images: [] } };
			}
			if (!auth) {
				return { content: [{ type: "text", text: "Error: no openai-codex OAuth entry found in ~/.pi/agent/auth.json. Run `pi` login for OpenAI Codex / ChatGPT first." }], details: { error: "openai-codex auth missing", model: null, images: [] } };
			}
			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) return { content: [{ type: "text", text: "Error: prompt is required." }], details: { error: "missing prompt", model: null, images: [] } };
			const model = resolveModel(params.model as string | null | undefined);
			const { formatId, ext } = resolveFormat(params.format);
			let inputImageUrl: string | undefined;
			const rawInput = params.input_image as string | undefined;
			if (rawInput && rawInput.trim().length > 0) {
				const r = await resolveInputImageUrl(rawInput);
				if ("error" in r) return { content: [{ type: "text", text: `Error: invalid input_image: ${r.error}` }], details: { error: r.error, model, images: [] } };
				inputImageUrl = r.url;
			}
			const outputDir = resolveOutputDir();
			ensureOutputDir(outputDir);
			const req = buildBody({
				model,
				prompt,
				formatId,
				size: typeof params.size === "string" ? params.size : undefined,
				quality: typeof params.quality === "string" ? params.quality : undefined,
				background: typeof params.background === "string" ? params.background : undefined,
				inputImageUrl,
			});
			try {
				const resp = await callOpenAICodexImage(auth, req.kind, req.body, signal);
				return await formatResult(prompt, model, resp, outputDir, ext);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error generating image with OpenAI Codex '${model}': ${msg}` }], details: { error: msg, model, images: [] } };
			}
		},
	});
}
