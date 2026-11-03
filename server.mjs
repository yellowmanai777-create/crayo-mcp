import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_BASE = "https://api.crayo.ai";
const KEY = process.env.CRAYO_API_KEY;
if (!KEY) { console.error("Set CRAYO_API_KEY"); process.exit(1); }
const PATH_SECRET = process.env.MCP_PATH_SECRET || crypto.randomBytes(24).toString("base64url");

async function crayo(method, path, { query, body } = {}) {
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const code = data?.error?.code ?? res.status;
    const msg = data?.error?.message ?? text.slice(0, 300);
    const retry = res.headers.get("retry-after");
    throw new Error(`Crayo ${res.status} ${code}: ${msg}${retry ? ` (retry after ${retry}s)` : ""}`);
  }
  return data;
}

function buildServer() {
  const server = new McpServer({ name: "crayo", version: "1.0.0" });
  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  const fail = (e) => ({ content: [{ type: "text", text: String(e.message ?? e) }], isError: true });
  const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

  server.registerTool("get_account", {
    description: "Crayo account: plan, credit balances (export/voiceover/image/video/tracker), storage, rate limits. Free. Call before anything that spends credits.",
    inputSchema: z.object({}),
  }, wrap(() => crayo("GET", "/v1/account")));

  server.registerTool("list_assets", {
    description: "List media library assets, newest first. Free.",
    inputSchema: z.object({ type: z.enum(["image","audio","video"]).optional(), category: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }),
  }, wrap((a) => crayo("GET", "/v1/assets", { query: a })));

  server.registerTool("get_asset", {
    description: "Get one asset (playable url, duration in seconds). Free.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("GET", `/v1/assets/${encodeURIComponent(id)}`)));

  server.registerTool("import_asset_from_url", {
    description: "Import a public https media file (max 100MB) into the Crayo library as an asset. Free (uses storage).",
    inputSchema: z.object({ url: z.string().url(), name: z.string().max(200).optional() }),
  }, wrap((a) => crayo("POST", "/v1/assets", { body: a })));

  server.registerTool("delete_asset", {
    description: "PERMANENTLY delete an asset and free its storage. Confirm with the user first.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("DELETE", `/v1/assets/${encodeURIComponent(id)}`)));

  server.registerTool("generate_image", {
    description: "Generate an image from a prompt; lands in the library as an asset. COSTS 1 image credit (not refunded on failure).",
    inputSchema: z.object({
      prompt: z.string().max(2000),
      model: z.enum(["black-forest-labs/flux-schnell","bytedance/seedream-4.5","bytedance/seedream-5-lite","ideogram-ai/ideogram-v3-turbo","bria/image-3.2","google/nano-banana","google/nano-banana-pro"]).optional(),
      aspect_ratio: z.enum(["1:1","16:9","9:16","4:3","3:4"]).optional(),
      reference_image_url: z.string().url().optional(),
    }),
  }, wrap((a) => crayo("POST", "/v1/image-generator", { body: a })));

  server.registerTool("list_voices", {
    description: "List narration voices (resolve a voice_id before generating audio). Free.",
    inputSchema: z.object({ gender: z.string().optional(), accent: z.string().optional(), search: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }),
  }, wrap((a) => crayo("GET", "/v1/voices", { query: a })));

  server.registerTool("generate_voiceover", {
    description: "Turn a script into narration audio. COSTS 1 voiceover credit per second (~750 chars/min), charged up front. Returns the audio asset + duration_seconds.",
    inputSchema: z.object({
      script: z.string().max(5000),
      voice_id: z.string(),
      title: z.string().optional(),
      settings: z.object({ stability: z.number().int().min(0).max(100).optional(), similarity: z.number().int().min(0).max(100).optional(), exaggeration: z.number().int().min(0).max(100).optional(), speed: z.number().min(0.7).max(1.2).optional() }).optional(),
    }),
  }, wrap((a) => crayo("POST", "/v1/voiceover-generator", { body: a })));

  server.registerTool("list_music", {
    description: "List background music tracks. Free.",
    inputSchema: z.object({ genre: z.enum(["recommended","rap","anime","sad","classical","quirky","chill","vlog"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }),
  }, wrap((a) => crayo("GET", "/v1/music", { query: a })));

  server.registerTool("list_subtitle_styles", {
    description: "List burned-in caption styles (style_id for project subtitles). Free.",
    inputSchema: z.object({}),
  }, wrap(() => crayo("GET", "/v1/subtitle-styles")));

  server.registerTool("create_transcript", {
    description: "Word-level transcript of an owned audio/video asset (max 30 min). COSTS 1 voiceover credit per second; cached per asset (repeat calls free).",
    inputSchema: z.object({ asset_id: z.string() }),
  }, wrap((a) => crayo("POST", "/v1/transcripts", { body: a })));

  const sceneSchema = z.object({
    asset_id: z.string(), start_ms: z.number().int().min(0), end_ms: z.number().int().positive(),
    trim_start_ms: z.number().int().min(0).optional(), volume: z.number().int().min(0).max(100).optional(),
    fit: z.enum(["cover","contain"]).optional(),
  });

  const projectFields = {
    title: z.string().max(200),
    scenes: z.array(sceneSchema).min(1).max(50),
    narration: z.object({ asset_id: z.string(), volume: z.number().int().min(0).max(100).optional() }).optional(),
    music: z.object({ track_id: z.string().optional(), asset_id: z.string().optional(), volume: z.number().int().min(0).max(100).optional() }).optional(),
    texts: z.array(z.object({ text: z.string().max(200), start_ms: z.number().int().min(0), end_ms: z.number().int().positive(), position: z.enum(["top","center","bottom"]).optional(), font_size: z.number().int().min(24).max(200).optional(), color: z.string().optional(), background_color: z.string().optional() })).max(20).optional(),
    subtitles: z.object({ style_id: z.string(), enabled: z.boolean().optional(), position: z.enum(["top","center","bottom"]).optional() }).optional(),
  };

  server.registerTool("create_project", {
    description: "Compose a vertical video project: ordered non-overlapping scenes + optional narration/music/texts/subtitles. Last scene's end_ms = video length (max 10 min). Free unless captions on (then 1 voiceover credit/sec to transcribe narration). Subtitles REQUIRE narration. Mute scene audio (volume 0) under narration. One create/export at a time per account.",
    inputSchema: z.object(projectFields),
  }, wrap((a) => crayo("POST", "/v1/projects", { body: a })));

  server.registerTool("list_projects", {
    description: "List projects (API + app + AutoClip clips; all exportable). Free.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }),
  }, wrap((a) => crayo("GET", "/v1/projects", { query: a })));

  server.registerTool("get_project", {
    description: "Get one project (API projects include their editable spec). Free.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("GET", `/v1/projects/${encodeURIComponent(id)}`)));

  server.registerTool("update_project", {
    description: "PATCH a project: send only changed fields; null removes a field. Content edits only on API-created projects (titles on any).",
    inputSchema: z.object({ id: z.string(), patch: z.record(z.any()) }),
  }, wrap(({ id, patch }) => crayo("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { body: patch })));

  server.registerTool("export_project", {
    description: "SPENDS CREDITS: queues a render at 1 export credit per second of finished video, charged immediately, NOT refunded if the render fails. Confirm with the user before calling. Max 2 renders at once. Poll get_export for the file.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("POST", `/v1/projects/${encodeURIComponent(id)}/export`)));

  server.registerTool("get_export", {
    description: "Check a render: queued → processing → completed/failed. Completed carries the downloadable video asset URL. Free; poll every ~5s.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("GET", `/v1/exports/${encodeURIComponent(id)}`)));

  server.registerTool("create_autoclip", {
    description: "SPENDS CREDITS: 1 video credit per requested clip, charged at start, kept even if fewer clips are found. Cuts a long video (1 min–3 hrs) into vertical shorts; each clip becomes an exportable project. Confirm with the user first.",
    inputSchema: z.object({
      asset_id: z.string(),
      clip_count: z.number().int().min(2).max(20).optional(),
      clip_length: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
      edit_level: z.enum(["clips","captions","cropped","full"]).optional(),
      formats: z.array(z.enum(["streamer","split","black-box","title-subtitles","full-video"])).min(1).max(5).optional(),
      prompt: z.string().max(500).optional(),
      mode: z.enum(["speech","energy"]).optional(),
      language: z.string().optional(),
    }),
  }, wrap((a) => crayo("POST", "/v1/autoclip", { body: a })));

  server.registerTool("get_autoclip", {
    description: "Check an AutoClip job; finished clips carry project_ids to export. Free.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("GET", `/v1/autoclip/${encodeURIComponent(id)}`)));

  server.registerTool("enhance_speech", {
    description: "SPENDS CREDITS: 1 voiceover credit per second of source (max 10 min), charged at start. Separates a recording into speech/music/background stems on GPU (1–3 min).",
    inputSchema: z.object({ asset_id: z.string() }),
  }, wrap((a) => crayo("POST", "/v1/speech-enhancer", { body: a })));

  server.registerTool("get_enhancement", {
    description: "Check a speech enhancement; completed carries stem URLs. Free.",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("GET", `/v1/speech-enhancer/${encodeURIComponent(id)}`)));

  server.registerTool("export_enhanced_mix", {
    description: "Render a mix of the three stems at given levels (0–2 each). Free; blocks a few seconds and returns the asset.",
    inputSchema: z.object({ id: z.string(), speech: z.number().min(0).max(2).optional(), music: z.number().min(0).max(2).optional(), background: z.number().min(0).max(2).optional(), format: z.enum(["mp4","wav","mp3"]).optional() }),
  }, wrap(({ id, ...body }) => crayo("POST", `/v1/speech-enhancer/${encodeURIComponent(id)}/export`, { body })));

  server.registerTool("lookup_profile", {
    description: "View Tracker raw: live profile lookup (followers, bio, links) on instagram/youtube/tiktok/twitter/facebook. COSTS 1 tracker credit (kept if target missing/private; refunded on Crayo-side failure).",
    inputSchema: z.object({ platform: z.enum(["instagram","youtube","tiktok","twitter","facebook"]), url: z.string().optional(), handle: z.string().optional() }),
  }, wrap(({ platform, ...q }) => crayo("GET", `/v1/view-tracker/raw/${platform}/profile`, { query: q })));

  server.registerTool("lookup_post", {
    description: "View Tracker raw: live post lookup (views, likes, comments, shares, saves...). COSTS 1 tracker credit.",
    inputSchema: z.object({ platform: z.enum(["instagram","youtube","tiktok","twitter","facebook"]), url: z.string() }),
  }, wrap(({ platform, ...q }) => crayo("GET", `/v1/view-tracker/raw/${platform}/post`, { query: q })));

  server.registerTool("create_tracker", {
    description: "Start a managed tracker for a profile or post. Free to create; each refresh costs 1 tracker credit (monthly cost = 43200 / interval_minutes — tell the user before creating). latest is null until the first refresh.",
    inputSchema: z.object({ url: z.string().optional(), handle: z.string().optional(), platform: z.enum(["instagram","youtube","tiktok","twitter"]).optional(), type: z.enum(["profile","post"]).optional(), interval_minutes: z.number().int().min(10).max(10080).optional(), max_posts: z.union([z.literal(50), z.literal(100), z.literal(200)]).optional() }),
  }, wrap((a) => crayo("POST", "/v1/view-tracker/trackers", { body: a })));

  server.registerTool("list_trackers", {
    description: "List managed trackers with latest stored readings. Free (stored).",
    inputSchema: z.object({ type: z.enum(["profile","post"]).optional(), platform: z.enum(["instagram","youtube","tiktok","twitter"]).optional(), status: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() }),
  }, wrap((a) => crayo("GET", "/v1/view-tracker/trackers", { query: a })));

  server.registerTool("get_tracker", {
    description: "Get one tracker + latest reading (also keeps it from going dormant). Free (stored).",
    inputSchema: z.object({ id: z.string() }),
  }, wrap(({ id }) => crayo("GET", `/v1/view-tracker/trackers/${encodeURIComponent(id)}`)));

  server.registerTool("crayo_request", {
    description: "Generic Crayo API call for any endpoint in the attached docs not covered by a dedicated tool (icon generator, face swap, voice changer, upload flow, webhooks, followers/following, history, tracker snapshots/events/insights, batch create, usage, exports list, deletes...). Check the docs for credit costs BEFORE calling anything that generates or fetches fresh data, and confirm credit-spending calls with the user.",
    inputSchema: z.object({
      method: z.enum(["GET","POST","PATCH","DELETE"]),
      path: z.string().regex(/^\/v1\//, "path must start with /v1/"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.record(z.any()).optional(),
    }),
  }, wrap(({ method, path, query, body }) => crayo(method, path, { query, body })));

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const mcpServer = buildServer();

app.post(`/mcp/${PATH_SECRET}`, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  } finally {
    transport.close();
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Crayo MCP server on :${port}`);
  console.log(`MCP endpoint path: /mcp/${PATH_SECRET}`);
  console.log(`Add to Claude: Settings → Connectors → Add custom connector → https://<your-domain>/mcp/${PATH_SECRET}`);
});
