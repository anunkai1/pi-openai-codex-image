/**
 * Loopback-only HTTP gateway for the OpenAI Codex OAuth image client.
 *
 * This lets server applications reuse pi's single Codex/ChatGPT OAuth login
 * without reading or managing ~/.pi/agent/auth.json themselves.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_MODEL, callOpenAICodexImage, getOpenAICodexAuth, type OpenAICodexImageResponse } from "../extensions/lib.js";

const HOST = process.env.CODEX_IMAGE_GATEWAY_HOST?.trim() || "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_IMAGE_GATEWAY_PORT ?? "", 10) || 4011;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 30_000;
const ALLOWED_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const ALLOWED_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const ALLOWED_FORMATS = new Set(["png", "jpeg", "webp"]);
const ALLOWED_BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);

interface GenerationRequest {
	prompt: string;
	model: string;
	size: string;
	quality: string;
	outputFormat: string;
	background: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

function badRequest(res: ServerResponse, message: string): void {
	sendJson(res, 400, { error: message });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const parts: Buffer[] = [];
	let size = 0;
	for await (const part of req) {
		const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
		parts.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(parts).toString("utf8"));
	} catch {
		throw new Error("request body must be JSON");
	}
}

function stringOption(value: unknown, fallback: string, allowed: Set<string>, name: string): string {
	if (value == null || value === "") return fallback;
	if (typeof value !== "string" || !allowed.has(value)) throw new Error(`invalid ${name}`);
	return value;
}

function parseGenerationRequest(value: unknown): GenerationRequest {
	if (value == null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("request body must be an object");
	}
	const body = value as Record<string, unknown>;
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (prompt.length === 0) throw new Error("prompt is required");
	if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters`);
	const model = body.model == null || body.model === "" ? DEFAULT_MODEL : body.model;
	if (model !== DEFAULT_MODEL) throw new Error(`unsupported model (only ${DEFAULT_MODEL} is available)`);
	return {
		prompt,
		model,
		size: stringOption(body.size, "auto", ALLOWED_SIZES, "size"),
		quality: stringOption(body.quality, "auto", ALLOWED_QUALITIES, "quality"),
		outputFormat: stringOption(body.output_format, "png", ALLOWED_FORMATS, "output_format"),
		background: stringOption(body.background, "auto", ALLOWED_BACKGROUNDS, "background"),
	};
}

function responseImage(response: OpenAICodexImageResponse): string | undefined {
	return response.data?.find((item) => typeof item.b64_json === "string" && item.b64_json.length > 0)?.b64_json;
}

// Codex image requests are deliberately serialised. The OAuth path is subject
// to subscription rate limits, and KidStories only needs one finished image at
// a time to make durable progress on a book.
let tail: Promise<void> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
	const next = tail.then(fn, fn);
	tail = next.then(() => undefined, () => undefined);
	return next;
}

async function handleGeneration(req: IncomingMessage, res: ServerResponse): Promise<void> {
	let input: GenerationRequest;
	try {
		input = parseGenerationRequest(await readJson(req));
	} catch (error) {
		badRequest(res, error instanceof Error ? error.message : String(error));
		return;
	}

	try {
		const response = await serialise(async () => {
			const auth = await getOpenAICodexAuth();
			if (!auth) throw new Error("OpenAI Codex OAuth is not signed in; run pi login on server2");
			return callOpenAICodexImage(auth, "generate", {
				prompt: input.prompt,
				model: input.model,
				background: input.background,
				quality: input.quality,
				size: input.size,
				output_format: input.outputFormat,
			}, undefined);
		});
		const image = responseImage(response);
		if (!image) throw new Error("OpenAI Codex returned no image data");
		sendJson(res, 200, {
			image,
			output_format: response.output_format ?? input.outputFormat,
			quality: response.quality ?? input.quality,
			size: response.size ?? input.size,
			background: response.background ?? input.background,
			model: input.model,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[codex-image-gateway] generation failed: ${message}`);
		sendJson(res, 502, { error: message });
	}
}

const server = createServer((req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		void getOpenAICodexAuth()
			.then((auth) => sendJson(res, auth ? 200 : 503, { status: auth ? "ok" : "unavailable", oauthConfigured: Boolean(auth) }))
			.catch(() => sendJson(res, 503, { status: "unavailable", oauthConfigured: false }));
		return;
	}
	if (req.method === "POST" && req.url === "/v1/images/generations") {
		void handleGeneration(req, res);
		return;
	}
	sendJson(res, 404, { error: "not found" });
});

server.requestTimeout = 190_000;
server.headersTimeout = 195_000;
server.listen(PORT, HOST, () => console.log(`[codex-image-gateway] listening on http://${HOST}:${PORT}`));
