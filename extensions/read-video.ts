// pi-ninfer-video — read a local video via a video-capable OpenAI-compat endpoint.
// Endpoint + api key follow pi's CURRENT provider (PI_PROVIDER, read from
// models.json) so nothing is hardcoded. Env vars override for explicit control:
//   READ_VIDEO_BASE_URL / READ_VIDEO_MODEL / READ_VIDEO_API_KEY
// Zero npm deps: Node built-in fs/os/path + global fetch.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 200 * 1024 * 1024;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// Resolve base url + api key from pi's current provider (PI_PROVIDER).
function currentProvider(): { baseUrl?: string; apiKey?: string } {
  const provider = process.env.PI_PROVIDER;
  if (!provider) return {};
  try {
    const raw = fs.readFileSync(path.join(agentDir(), "models.json"), "utf8");
    const cfg = JSON.parse(raw)?.providers?.[provider];
    return { baseUrl: cfg?.baseUrl, apiKey: cfg?.apiKey };
  } catch {
    return {};
  }
}

function resolve() {
  const pc = currentProvider();
  return {
    baseUrl: (process.env.READ_VIDEO_BASE_URL || pc.baseUrl || "").replace(/\/$/, ""),
    model: process.env.READ_VIDEO_MODEL || process.env.PI_MODEL || "",
    apiKey: process.env.READ_VIDEO_API_KEY || pc.apiKey || "",
    provider: process.env.PI_PROVIDER || "(none)",
  };
}

function mimeFor(p: string): string {
  const e = p.toLowerCase();
  if (e.endsWith(".mov") || e.endsWith(".qt")) return "video/quicktime";
  if (e.endsWith(".mkv")) return "video/x-matroska";
  if (e.endsWith(".webm")) return "video/webm";
  if (e.endsWith(".avi")) return "video/x-msvideo";
  return "video/mp4";
}

export default function (pi: any) {
  pi.registerTool({
    name: "read_video",
    label: "Read Video",
    description:
      "Read a local video file. Sends it (base64 video_url) to the video-capable model on pi's current provider endpoint and returns its description / transcription.",
    promptSnippet: "Send a local video to the current provider's video model and get a description",
    promptGuidelines: [
      "Use read_video when the user asks to read, describe, or transcribe a local video file.",
      "Pass the absolute path of the video in `video`; an optional `question` focuses the answer.",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        video: { type: "string", description: "Absolute path to the local video file (.mov/.mp4/.mkv/...)" },
        question: { type: "string", description: "Optional question to focus the answer. Omit for a full description." },
      },
      required: ["video"],
    },
    execute: async (_toolCallId: string, params: any) => {
      const { baseUrl, model, apiKey, provider } = resolve();
      if (!baseUrl || !apiKey || !model) {
        return {
          content: [
            {
              type: "text" as const,
              text: `pi-ninfer-video: could not resolve a video endpoint. pi provider=${provider} (check it has baseUrl+apiKey in models.json), or set READ_VIDEO_BASE_URL / READ_VIDEO_API_KEY / READ_VIDEO_MODEL.`,
            },
          ],
          isError: true,
        };
      }
      const video: string = params?.video;
      if (!video || !fs.existsSync(video)) {
        return { content: [{ type: "text" as const, text: `Error: video file not found: ${video}` }], isError: true };
      }
      const size = fs.statSync(video).size;
      if (size > MAX_BYTES) {
        return {
          content: [{ type: "text" as const, text: `Error: video too large (${(size / 1048576).toFixed(1)} MB > 200 MB limit).` }],
          isError: true,
        };
      }
      const b64 = fs.readFileSync(video, "base64");
      const uri = `data:${mimeFor(video)};base64,${b64}`;
      const question: string =
        params?.question || "详细描述这段视频：主体物体、场景、任何动作/变化/闪烁、以及画面上的文字。";
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: question }, { type: "video_url", video_url: { url: uri } }],
              },
            ],
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          return {
            content: [{ type: "text" as const, text: `Model endpoint error (HTTP ${res.status}): ${txt.slice(0, 2000)}` }],
            isError: true,
          };
        }
        const data: any = await res.json();
        const text = data?.choices?.[0]?.message?.content ?? "(empty response)";
        return {
          content: [
            {
              type: "text" as const,
              text: `--- read_video: ${video} · provider=${provider} · model=${model} · ${(size / 1048576).toFixed(1)} MB ---\n${text}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error calling model: ${e?.message || e}` }], isError: true };
      }
    },
  });
}
