/** pi-openai-codex-image — OpenAI GPT image generation via Codex/ChatGPT OAuth.
 *
 * Uses the same OAuth-backed backend upstream Codex's built-in image_gen tool
 * uses (`chatgpt.com/backend-api/codex/images/...`). This is NOT the public
 * OpenAI Platform /v1/images API and does NOT require OPENAI_API_KEY; it uses
 * ~/.pi/agent/auth.json's `openai-codex` OAuth entry.
 */

import Type from "typebox";
import {
	DEFAULT_MODEL,
	IMAGE_MODELS,
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

const ImageGenerateBatchParams = Type.Object({
	prompts: Type.Array(Type.String(), { minItems: 1, maxItems: 8, description: "One prompt per image. Sequential requests, one image each." }),
	model: ImageGenerateParams.properties.model,
	size: ImageGenerateParams.properties.size,
	quality: ImageGenerateParams.properties.quality,
	background: ImageGenerateParams.properties.background,
	format: ImageGenerateParams.properties.format,
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

function persistFirst(resp: OpenAICodexImageResponse, outputDir: string, fallbackExt: string): string | null {
	const b64 = resp.data?.find((x) => typeof x.b64_json === "string" && x.b64_json.length > 0)?.b64_json;
	if (!b64) return null;
	const ext = extFromOutputFormat(resp.output_format, fallbackExt);
	return writeBase64(b64, outputDir, ext);
}

function formatResult(prompt: string, model: string, resp: OpenAICodexImageResponse, outputDir: string, fallbackExt: string) {
	const url = persistFirst(resp, outputDir, fallbackExt);
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
				const r = resolveInputImageUrl(rawInput);
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
				return formatResult(prompt, model, resp, outputDir, ext);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error generating image with OpenAI Codex '${model}': ${msg}` }], details: { error: msg, model, images: [] } };
			}
		},
	});

	pi.registerTool({
		name: "openai_codex_generate_images",
		label: "OpenAI Codex: Generate Image Batch",
		description: "Batch image generation via OpenAI Codex/ChatGPT OAuth: one image per prompt (1–8), sequential. Does not support img2img; use openai_codex_generate_image for edits.",
		promptSnippet: "Use for multiple GPT images via OpenAI Codex/ChatGPT OAuth. One image per prompt; sequential.",
		parameters: ImageGenerateBatchParams,
		async execute(_callId, params, signal) {
			let auth;
			try { auth = await getOpenAICodexAuth(); } catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error resolving OpenAI Codex OAuth: ${msg}` }], details: { error: msg, model: null, results: [] } };
			}
			if (!auth) return { content: [{ type: "text", text: "Error: no openai-codex OAuth entry found in ~/.pi/agent/auth.json." }], details: { error: "openai-codex auth missing", model: null, results: [] } };
			const prompts = Array.isArray(params.prompts) ? (params.prompts as unknown[]).map(String).filter((s) => s.trim().length > 0) : [];
			if (prompts.length === 0) return { content: [{ type: "text", text: "Error: prompts must contain at least one non-empty string." }], details: { error: "missing prompts", model: null, results: [] } };
			const model = resolveModel(params.model as string | null | undefined);
			const { formatId, ext } = resolveFormat(params.format);
			const outputDir = resolveOutputDir();
			ensureOutputDir(outputDir);
			const results: Array<{ prompt: string; url?: string; response?: OpenAICodexImageResponse; error?: string }> = [];
			for (const p of prompts) {
				const req = buildBody({
					model,
					prompt: p,
					formatId,
					size: typeof params.size === "string" ? params.size : undefined,
					quality: typeof params.quality === "string" ? params.quality : undefined,
					background: typeof params.background === "string" ? params.background : undefined,
				});
				try {
					const resp = await callOpenAICodexImage(auth, req.kind, req.body, signal);
					const url = persistFirst(resp, outputDir, ext) ?? undefined;
					results.push(url ? { prompt: p, url, response: resp } : { prompt: p, error: "no decodable image in response", response: resp });
				} catch (err) {
					results.push({ prompt: p, error: err instanceof Error ? err.message : String(err) });
				}
			}
			const ok = results.filter((r) => r.url);
			const fail = results.filter((r) => r.error);
			const lines = [`OpenAI Codex batch with **${model}** (${ok.length}/${results.length} succeeded):`, ""];
			for (const r of ok) lines.push(`- ${r.prompt.slice(0, 80)}: ![](${r.url})`);
			if (fail.length) {
				lines.push("", `Failed (${fail.length}):`);
				for (const r of fail) lines.push(`- ${r.prompt.slice(0, 80)}: ${r.error}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { model, results } };
		},
	});

	void IMAGE_MODELS;
	void DEFAULT_MODEL;
}
