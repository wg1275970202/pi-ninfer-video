import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent, ToolDefinition } from "@mariozechner/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXTENSION_NAME = "pi-ninfer-video";
const MAX_BYTES = 48 * 1024 * 1024; // 48 MB base64 cap

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/mp4",
};

function resolveMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? "video/mp4";
}

type ModelsJson = {
  defaultProvider?: string;
  providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
};

function readModelsJson(): ModelsJson | undefined {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const mf = path.join(agentDir, "models.json");
    const parsed = JSON.parse(fs.readFileSync(mf, "utf-8")) as ModelsJson;
    if (parsed && typeof parsed === "object") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

// defaultProvider / defaultModel live in settings.json (NOT models.json).
function readSettings(): { defaultProvider?: string; defaultModel?: string } | undefined {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const sf = path.join(agentDir, "settings.json");
    const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
    return d && typeof d === "object" ? d : undefined;
  } catch {
    return undefined;
  }
}

function readDefaultProvider(): string | undefined {
  return readSettings()?.defaultProvider;
}

// Fallback only: read the current provider (PI_PROVIDER or defaultProvider) from models.json.
function currentProvider(): { baseUrl?: string; apiKey?: string } | undefined {
  const name = process.env.PI_PROVIDER || readDefaultProvider();
  if (!name) return undefined;
  const p = readModelsJson()?.providers?.[name];
  return p ? { baseUrl: p.baseUrl, apiKey: p.apiKey } : undefined;
}

// Endpoint resolution, in priority order:
//   env override  >  pi-injected ctx.model.config  >  pi getApiKeyAndHeaders  >  models.json
// pi injects the active provider's config into the extension context; the env
// PI_PROVIDER is NOT available at extension runtime, so ctx is the primary source.
async function resolveEndpoint(ctx: any): Promise<{ baseUrl?: string; apiKey?: string; model?: string }> {
  const cfg = (ctx?.model?.config as any) ?? {};
  const envBase = process.env.READ_VIDEO_BASE_URL;
  const envKey = process.env.READ_VIDEO_API_KEY;
  const envModel = process.env.READ_VIDEO_MODEL;
  const inherited = currentProvider();

  const baseUrl = envBase || (typeof cfg.baseUrl === "string" && cfg.baseUrl) || inherited?.baseUrl;
  let apiKey = envKey || (typeof cfg.apiKey === "string" && cfg.apiKey) || inherited?.apiKey;
  if (!apiKey && typeof ctx?.getApiKeyAndHeaders === "function") {
    try {
      const r = await ctx.getApiKeyAndHeaders(ctx.model?.provider);
      apiKey = (typeof r?.apiKey === "string" && r.apiKey) || undefined;
    } catch {
      /* ignore */
    }
  }
  const settings = readSettings();
  const model =
    envModel ||
    (typeof ctx?.model?.id === "string" ? ctx.model.id : undefined) ||
    settings?.defaultModel ||
    process.env.PI_MODEL ||
    undefined;

  return { baseUrl, apiKey, model };
}

function buildError(kind: "no_endpoint" | "bad_response" | "other", detail?: string) {
  const msg =
    kind === "no_endpoint"
      ? `${EXTENSION_NAME}: could not resolve a video endpoint. Check your pi provider exposes baseUrl/apiKey (ctx.model.config / getApiKeyAndHeaders), or set READ_VIDEO_BASE_URL / READ_VIDEO_API_KEY / READ_VIDEO_MODEL. (diag: ~/.pi/read-video-diag.json)`
      : kind === "bad_response"
        ? `${EXTENSION_NAME}: provider returned an unusable response. ${detail ?? ""}`.trim()
        : `${EXTENSION_NAME}: ${detail ?? "unknown error"}`;
  return {
    content: [{ type: "text" as const, text: msg }],
    details: { error: { kind, message: msg } },
  };
}

function writeDiag(ctx: any, baseUrl?: string, apiKey?: string, model?: string) {
  try {
    const p = path.join(os.homedir(), ".pi", "read-video-diag.json");
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          baseUrl,
          hasKey: !!apiKey,
          model,
          model_id: ctx?.model?.id,
          model_provider: ctx?.model?.provider,
          model_keys: ctx?.model ? Object.keys(ctx.model) : null,
          model_config: ctx?.model?.config ?? null,
          model_config_keys: ctx?.model?.config ? Object.keys(ctx.model.config) : null,
          has_getApiKeyAndHeaders: typeof ctx?.getApiKeyAndHeaders,
          env_PI_PROVIDER: process.env.PI_PROVIDER,
          env_PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        },
        null,
        2
      )
    );
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  const tool: ToolDefinition<"video", { video: string; question?: string }> = {
    name: "read_video",
    label: "Read video",
    display: true,
    description:
      "Read a local video file. Sends it (base64 video_url) to a video-capable " +
      "OpenAI-compatible model endpoint and returns the model's description / transcription. " +
      "Endpoint, key and model default to pi's current provider (ctx.model.config), " +
      "so a local endpoint like ninfer works automatically. " +
      "Override with READ_VIDEO_BASE_URL / READ_VIDEO_MODEL / READ_VIDEO_API_KEY.",
    parameters: {
      video: {
        type: "string",
        description: "Absolute path to the local video file (.mov/.mp4/.mkv/...)",
      },
      question: {
        type: "string",
        description: "Optional question to focus the answer. Omit for a full description.",
      },
    },
    async execute(_id, args, ctx, _signal, _onUpdate) {
      const video = (args as any)?.video;
      const prompt = (args as any)?.question;
      if (!video || typeof video !== "string") {
        return buildError("other", 'missing required arg "video" (absolute path)');
      }
      const abs = path.resolve(video);
      if (!fs.existsSync(abs)) {
        return buildError("other", `video file not found: ${abs}`);
      }
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        return buildError("other", `not a file: ${abs}`);
      }
      if (st.size > MAX_BYTES) {
        return buildError("other", `video too large (${(st.size / 1024 / 1024).toFixed(1)} MB > ${MAX_BYTES / 1024 / 1024} MB limit)`);
      }

      const { baseUrl, apiKey, model } = await resolveEndpoint(ctx);
      if (!baseUrl || !apiKey) {
        writeDiag(ctx, baseUrl, apiKey, model);
        return buildError("no_endpoint");
      }
      if (!model) {
        return buildError("no_endpoint", "no model id resolvable (set READ_VIDEO_MODEL)");
      }

      const mime = resolveMime(abs);
      const b64 = fs.readFileSync(abs).toString("base64");
      const promptText = prompt && prompt.trim() ? prompt.trim() : "Describe this video in detail.";
      const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "video_url", video_url: { url: `data:${mime};base64,${b64}` } },
                  { type: "text", text: promptText },
                ],
              },
            ],
          }),
        });
      } catch (e) {
        return buildError("other", `fetch failed: ${(e as Error).message ?? String(e)}`);
      }

      const text = await resp.text();
      if (!resp.ok) {
        const snippet = text.length > 400 ? text.slice(0, 400) + "…" : text;
        return buildError("other", `provider HTTP ${resp.status}: ${snippet}`);
      }
      let data: any;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return buildError("bad_response", `response is not JSON: ${(e as Error).message ?? String(e)}`);
      }

      const choice = data?.choices?.[0];
      let answer: unknown = choice?.message?.content ?? choice?.delta?.content ?? data?.message?.content ?? data?.content;
      if (Array.isArray(answer)) {
        answer = (answer as any[])
          .map((p) => (typeof p === "string" ? p : (p as any)?.text ?? ""))
          .join("\n")
          .trim();
      }
      if (typeof answer !== "string" || !answer.trim()) {
        const snippet = text.length > 400 ? text.slice(0, 400) + "…" : text;
        return buildError("bad_response", `no text content in response: ${snippet}`);
      }

      const out: (TextContent | ImageContent)[] = [{ type: "text", text: answer.trim() }];
      if (Array.isArray(data?.message?.images)) {
        for (const im of data.message.images) {
          if (im?.type === "data" && im?.data && im?.mime) {
            out.push({ type: "image", data: im.data, mimeType: im.mime });
          }
        }
      }
      return { content: out, details: { model, bytes: st.size } };
    },
  };

  pi.registerTool(tool);
}
