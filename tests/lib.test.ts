import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MODEL,
	callOpenAICodexImage,
	ensureOutputDir,
	extFromOutputFormat,
	resolveFormat,
	resolveInputImageUrl,
	resolveModel,
	writeBase64,
} from "../extensions/lib.js";

describe("resolveFormat / extFromOutputFormat", () => {
	it("defaults to png", () => expect(resolveFormat(undefined)).toEqual({ formatId: "png", ext: "png" }));
	it("maps jpg/jpeg", () => expect(resolveFormat("jpg")).toEqual({ formatId: "jpeg", ext: "jpg" }));
	it("maps response output_format", () => {
		expect(extFromOutputFormat("png", "jpg")).toBe("png");
		expect(extFromOutputFormat("jpeg", "png")).toBe("jpg");
		expect(extFromOutputFormat("weird", "png")).toBe("png");
	});
});

describe("resolveModel", () => {
	const home = process.env.HOME;
	let tmp: string;
	beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "poci-model-")); process.env.HOME = tmp; delete process.env.OPENAI_CODEX_IMAGE_MODEL; });
	afterEach(async () => { process.env.HOME = home; delete process.env.OPENAI_CODEX_IMAGE_MODEL; await rm(tmp, { recursive: true, force: true }); });
	it("defaults", () => expect(resolveModel(undefined)).toBe(DEFAULT_MODEL));
	it("honours explicit", () => expect(resolveModel("x")).toBe("x"));
	it("strips openai-codex tag", async () => {
		await mkdir(join(tmp, ".config", "acb"), { recursive: true });
		await writeFile(join(tmp, ".config", "acb", "image-model"), "openai-codex/gpt-image-2\n");
		expect(resolveModel(undefined)).toBe("gpt-image-2");
	});
	it("falls through on other backend tags", async () => {
		await mkdir(join(tmp, ".config", "acb"), { recursive: true });
		await writeFile(join(tmp, ".config", "acb", "image-model"), "openrouter/openai/gpt-image-2\n");
		process.env.OPENAI_CODEX_IMAGE_MODEL = "env-model";
		expect(resolveModel(undefined)).toBe("env-model");
	});
});

describe("resolveInputImageUrl", () => {
	it("passes data/http", async () => {
		expect(await resolveInputImageUrl("data:image/png;base64,AAAA")).toEqual({ url: "data:image/png;base64,AAAA" });
		expect(await resolveInputImageUrl("https://x/y.png")).toEqual({ url: "https://x/y.png" });
	});
	it("reads local file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "poci-in-"));
		try {
			const f = join(dir, "a.jpg");
			await writeFile(f, Buffer.from([1,2,3]));
			const r = await resolveInputImageUrl(f);
			expect("url" in r).toBe(true);
			expect((r as {url:string}).url).toMatch(/^data:image\/jpeg;base64,/);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});

describe("writeBase64", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "poci-out-")); ensureOutputDir(dir); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
	it("writes uploads URL", async () => expect(await writeBase64("aGVsbG8=", dir, "png")).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/));
	it("returns null for empty", async () => expect(await writeBase64("", dir, "png")).toBeNull());
});

describe("callOpenAICodexImage", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
	it("posts generation request and parses response", async () => {
		globalThis.fetch = vi.fn(async (_url, init) => {
			expect(String(_url)).toContain("/codex/images/generations");
			expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer tok");
			return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "abc" }], output_format: "png", quality: "low", size: "1254x1254" }), { status: 200 });
		}) as unknown as typeof fetch;
		const r = await callOpenAICodexImage({ access: "tok", accountId: "acct" }, "generate", { prompt: "p", model: "gpt-image-2" }, undefined);
		expect(r.data?.[0]?.b64_json).toBe("abc");
	});
	it("does not retry 400", async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 })) as unknown as typeof fetch;
		await expect(callOpenAICodexImage({ access: "tok" }, "generate", {}, undefined)).rejects.toThrow(/bad/);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	it("retries 429", async () => {
		let n = 0;
		globalThis.fetch = vi.fn(async () => (++n < 3 ? new Response("rate", { status: 429 }) : new Response(JSON.stringify({ data: [{ b64_json: "ok" }] }), { status: 200 }))) as unknown as typeof fetch;
		const r = await callOpenAICodexImage({ access: "tok" }, "generate", {}, undefined);
		expect(r.data?.[0]?.b64_json).toBe("ok");
		expect(n).toBe(3);
	});
});
