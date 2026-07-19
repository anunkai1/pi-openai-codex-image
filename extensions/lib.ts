/**
 * Pure helpers for pi-openai-codex-image — OpenAI/ChatGPT OAuth-backed image
 * generation through Codex's private backend, NOT the public OpenAI Platform
 * /v1/images API. This matches upstream OpenAI Codex's built-in `image_gen`
 * extension path:
 *   POST https://chatgpt.com/backend-api/codex/images/generations
 *   POST https://chatgpt.com/backend-api/codex/images/edits
 *
 * Auth comes from ~/.pi/agent/auth.json's `openai-codex` OAuth entry:
 * { access, refresh, expires, accountId }. The public Platform API rejects this
 * token for /v1/models with missing api.* scopes, but the Codex backend accepts
 * it when paired with ChatGPT-Account-ID.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_IMAGE_GENERATIONS_ENDPOINT = `${CODEX_BASE}/images/generations`;
export const CODEX_IMAGE_EDITS_ENDPOINT = `${CODEX_BASE}/images/edits`;
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Upstream Codex's built-in imagegen tool fixes this model. The backend may
 *  return metadata like `gpt-image-2-codex`, `quality:auto`, `size:auto` even
 *  when explicit size/quality are requested; we surface response metadata when
 *  present and treat request size/quality as hints. */
export const DEFAULT_MODEL = "gpt-image-2";
export const OUTPUT_URL_PREFIX = "/uploads/";

export interface ImageModelEntry {
	id: string;
	name: string;
	tags: readonly string[];
}

export const IMAGE_MODELS: readonly ImageModelEntry[] = [
	{ id: "gpt-image-2", name: "GPT Image 2 (Codex/ChatGPT OAuth)", tags: ["openai", "codex", "oauth"] },
];

export const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_CODEX_IMAGE_TIMEOUT_MS ?? "", 10) || 180_000;
export const MAX_RETRIES = Math.max(0, Number.parseInt(process.env.OPENAI_CODEX_IMAGE_MAX_RETRIES ?? "", 10) || 2);
const BACKOFF_BASE_MS = 500;

export function imageModelOverrideFile(): string {
	return join(process.env.HOME ?? homedir(), ".config", "acb", "image-model");
}

export function resolveOutputDir(): string {
	const fromEnv = process.env.ACB_UPLOADS_DIR?.trim();
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return join(process.cwd(), "uploads");
}

export function ensureOutputDir(outputDir: string): void {
	mkdirSync(outputDir, { recursive: true });
}

export function resolveFormat(format: unknown): { formatId: string; ext: string } {
	const f = (typeof format === "string" ? format : "png").trim().toLowerCase();
	if (f === "webp") return { formatId: "webp", ext: "webp" };
	if (f === "jpeg" || f === "jpg") return { formatId: "jpeg", ext: "jpg" };
	return { formatId: "png", ext: "png" };
}

export function extFromOutputFormat(format: unknown, fallbackExt: string): string {
	const f = typeof format === "string" ? format.trim().toLowerCase() : "";
	if (f === "png") return "png";
	if (f === "jpeg" || f === "jpg") return "jpg";
	if (f === "webp") return "webp";
	return fallbackExt;
}

/** Order: explicit param > source-tagged shared picker override (openai-codex/
 *  only) > env > built-in default. Fall through on every other backend tag. */
export function resolveModel(explicit?: string | null | undefined): string {
	if (explicit && explicit.length > 0) return explicit;
	try {
		const overrideFile = imageModelOverrideFile();
		if (existsSync(overrideFile)) {
			const raw = readFileSync(overrideFile, "utf8").trim();
			if (raw.length > 0) {
				if (raw.startsWith("openai-codex/")) return raw.slice("openai-codex/".length);
				if (raw.startsWith("local/") || raw.startsWith("venice/") || raw.startsWith("openrouter/")) {
					// Active model is on another backend; fall through.
				} else {
					return raw; // bare legacy id
				}
			}
		}
	} catch {
		/* fall through */
	}
	return process.env.OPENAI_CODEX_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
}

export interface OpenAICodexAuth {
	access: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
}

function authFilePath(): string {
	return join(process.env.HOME ?? homedir(), ".pi", "agent", "auth.json");
}

function readAuthFile(): Record<string, unknown> | null {
	try {
		const file = authFilePath();
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function writeAuthFile(auth: Record<string, unknown>): void {
	const file = authFilePath();
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

/** Resolve/refresh the Codex OAuth token. Refreshes when expiry is within 60s.
 *  Persists refreshed access/refresh/expires back to auth.json (same file Pi
 *  uses) so future sessions benefit. */
export async function getOpenAICodexAuth(): Promise<OpenAICodexAuth | undefined> {
	const auth = readAuthFile();
	const entry = auth?.["openai-codex"] as Record<string, unknown> | undefined;
	if (!entry || typeof entry.access !== "string" || entry.access.length === 0) return undefined;
	const out: OpenAICodexAuth = {
		access: entry.access,
		refresh: typeof entry.refresh === "string" ? entry.refresh : undefined,
		expires: typeof entry.expires === "number" ? entry.expires : undefined,
		accountId: typeof entry.accountId === "string" ? entry.accountId : undefined,
	};
	const expires = out.expires ?? 0;
	if (!out.refresh || expires > Date.now() + 60_000) return out;

	const refreshed = await refreshOpenAICodexAuth(out.refresh);
	const nextEntry = { ...entry, ...refreshed };
	if (auth) {
		auth["openai-codex"] = nextEntry;
		writeAuthFile(auth);
	}
	return {
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
		accountId: out.accountId,
	};
}

async function refreshOpenAICodexAuth(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
	const res = await fetch(OPENAI_CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`OpenAI Codex token refresh failed (${res.status}): ${text.slice(0, 500)}`);
	}
	const json = (await res.json()) as Record<string, unknown>;
	if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string" || typeof json.expires_in !== "number") {
		throw new Error(`OpenAI Codex token refresh response missing fields: ${JSON.stringify(json).slice(0, 500)}`);
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

export function writeBase64(raw: string, outputDir: string, ext: string): string | null {
	const comma = raw.indexOf(",");
	const b64 = raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
	const buf = Buffer.from(b64, "base64");
	if (buf.length === 0) return null;
	const filename = `${randomUUID()}.${ext}`;
	writeFileSync(join(outputDir, filename), buf);
	return `${OUTPUT_URL_PREFIX}${filename}`;
}

export function resolveInputImageUrl(input: string): { url: string } | { error: string } {
	const s = input.trim();
	if (s.length === 0) return { error: "empty input_image" };
	if (s.startsWith("data:") || /^https?:\/\//i.test(s)) return { url: s };
	let diskPath = s;
	if (s.startsWith(OUTPUT_URL_PREFIX)) diskPath = join(resolveOutputDir(), s.slice(OUTPUT_URL_PREFIX.length));
	try {
		if (!existsSync(diskPath)) return { error: `input_image not found: ${s}` };
		const buf = readFileSync(diskPath);
		return { url: `data:${sniffMimeType(diskPath)};base64,${buf.toString("base64")}` };
	} catch (err) {
		return { error: `could not read input_image ${s}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function sniffMimeType(path: string): string {
	const ext = path.toLowerCase().split(".").pop() ?? "";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "webp") return "image/webp";
	return "image/png";
}

export interface OpenAICodexImageResponse {
	created?: number;
	background?: string;
	data?: Array<{ b64_json?: string }>;
	output_format?: string;
	quality?: string;
	size?: string;
	usage?: Record<string, unknown>;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
	});
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
	const parts: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
	if (signal) parts.push(signal);
	return AbortSignal.any(parts);
}

function extractErrorMessage(body: unknown, status: number): string {
	if (body != null && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		const err = obj.error;
		if (err != null && typeof err === "object") {
			const msg = (err as Record<string, unknown>).message;
			if (typeof msg === "string" && msg.length > 0) return `OpenAI Codex image API ${status}: ${msg.slice(0, 500)}`;
		}
		if (typeof err === "string" && err.length > 0) return `OpenAI Codex image API ${status}: ${err.slice(0, 500)}`;
		if (typeof obj.message === "string" && obj.message.length > 0) return `OpenAI Codex image API ${status}: ${obj.message.slice(0, 500)}`;
	}
	if (typeof body === "string" && body.length > 0) return `OpenAI Codex image API ${status}: ${body.slice(0, 500)}`;
	return `OpenAI Codex image API ${status}`;
}

export async function callOpenAICodexImage(
	auth: OpenAICodexAuth,
	kind: "generate" | "edit",
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<OpenAICodexImageResponse> {
	const endpoint = kind === "edit" ? CODEX_IMAGE_EDITS_ENDPOINT : CODEX_IMAGE_GENERATIONS_ENDPOINT;
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		let res: Response;
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${auth.access}`,
				"OpenAI-Beta": "responses=experimental",
			};
			if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
			res = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: withTimeout(signal),
			});
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new Error(`OpenAI Codex image request failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (res.ok) return (await res.json()) as OpenAICodexImageResponse;
		const text = await res.text().catch(() => "");
		let parsed: unknown = text;
		try { parsed = text.length > 0 ? JSON.parse(text) : undefined; } catch { /* keep text */ }
		const retryable = res.status === 429 || res.status >= 500;
		lastError = new Error(extractErrorMessage(parsed, res.status));
		if (retryable && attempt < MAX_RETRIES) {
			await sleep(BACKOFF_BASE_MS * 2 ** attempt, signal);
			continue;
		}
		throw lastError;
	}
	throw lastError ?? new Error("OpenAI Codex image request failed");
}
