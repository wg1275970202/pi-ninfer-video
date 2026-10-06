# pi-ninfer-video

A tiny pi extension that adds a `read_video` tool: it reads a local video file
and sends it (base64 `video_url`) to a **video-capable OpenAI-compatible model**,
returning the model's description / transcription.

**No hardcoded keys or endpoints.** The endpoint and API key are inherited from
pi's **active provider**, resolved from `settings.json` (`defaultProvider` /
`defaultModel`) plus the pi agent dir's `models.json`, so if pi is using a local
ninfer instance, `read_video` automatically uses that instance's base URL and key.

**Tested against a local [NInfer](https://github.com/Neroued/ninfer)** serving
Qwen3.8-27B (video-capable). The mechanism is provider-agnostic — it inherits
whatever provider pi is currently using — but with one hard requirement: that
provider's model must genuinely accept **video** input. Endpoints that only take
text/image (e.g. a Strata / Qwen3.8-Flash-Next setup) connect fine but cannot
see video frames.

## Install

Add the npm package to the `packages` array in `~/.pi/agent/settings.json`:

```
"npm:pi-ninfer-video"
```
then `/reload` (new sessions load it automatically).

(Or the git source: `"git:github.com/wg1275970202/pi-ninfer-video"`.)

Or manually: clone / copy this directory to `~/.pi/agent/extensions/pi-ninfer-video/`
(entry point `extensions/read-video.ts`).

## How it picks the endpoint + key

Resolution order (first non-empty value wins):

| value    | order                                              |
|----------|----------------------------------------------------|
| base URL | `READ_VIDEO_BASE_URL` → current provider's `baseUrl` |
| model    | `READ_VIDEO_MODEL` → active model → `PI_MODEL`        |
| api key  | `READ_VIDEO_API_KEY` → current provider's `apiKey`  |

The active provider is `PI_PROVIDER` when set, otherwise `settings.json`'s
`defaultProvider` (both in the pi agent dir, `PI_CODING_AGENT_DIR`); its
`baseUrl`/`apiKey` come from `models.json`. Each user's pi reads **their own**
`models.json` — no key ever ships inside the package.

So on a machine where pi's active provider is a local ninfer endpoint,
`read_video` just works with zero configuration.

## Configuration (optional overrides)

Set any of these to override the inherited values:

```bash
export READ_VIDEO_BASE_URL="http://127.0.0.1:8080/v1"
export READ_VIDEO_MODEL="qwen3.8-27b"
export READ_VIDEO_API_KEY="sk-..."
```

## Usage

Just tell pi to describe a video by path, e.g. `describe clip.mp4`. The model
calls `read_video({"video": "<path>", "question": "..."})`.

## Requirements

- Node.js 18+ (uses built-in `fetch` + `fs`; zero npm dependencies)
- A video-capable OpenAI-compatible backend — the current provider must actually
  understand `video_url` inputs (e.g. a Qwen-VL class model served locally)

## Limitations

- Single file up to 48 MB (client-side cap).
- Sends the video bytes to the resolved endpoint (privacy depends on your backend).
- The current provider must genuinely support video input; otherwise the model
  cannot see the frames.

## Compatibility

`read_video` sends an OpenAI-standard `video_url` (base64). It works with any
OpenAI-compatible backend whose model actually accepts video input:

| Backend | Video input | `read_video` |
|---------|-------------|--------------|
| NInfer  | yes         | ✅ tested |
| vLLM (Qwen2.5-VL / Qwen3-VL) | yes | ✅ supported |
| llama.cpp / mtmd (new) | yes | ⚠️ version-dependent |
| LocalAI (new) | yes | ⚠️ version-dependent |
| Ollama (stock) | no | ❌ |
| Strata | image only | ❌ |
