/**
 * Transcript Studio — Cloudflare Worker
 *
 * This worker is the only place that knows the GEMINI_API_KEY.
 * The key is stored as a Cloudflare secret (never in source code or git).
 *
 * Endpoints:
 *   POST /api/upload-session  → starts a Google resumable upload, returns { uploadUrl }
 *   POST /api/transcribe      → polls file state + runs Gemini transcription
 *   POST /api/chat            → runs Gemini chat with transcript context
 */

// ─── CORS headers sent on every response ─────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// ─── /api/upload-session ──────────────────────────────────────────────────────
// The browser asks us to start a resumable upload with Google.
// We call Google using our secret key, then return only the session URL.
// The session URL does NOT contain the API key — it is safe to send to the browser.
async function handleUploadSession(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker. Add it via: wrangler secret put GEMINI_API_KEY" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { fileName, fileSize, mimeType } = body;

  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileSize),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: fileName || "media" } }),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    return json(500, { error: `Failed to start Google upload session: ${errText}` });
  }

  const uploadUrl = initRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    return json(500, { error: "Google Files API did not return an upload URL." });
  }

  return json(200, { uploadUrl });
}

// ─── /api/transcribe ──────────────────────────────────────────────────────────
// After the browser uploads the file directly to Google, it sends us
// { fileUri, fileName, language, mimeType }.
// We poll until ACTIVE, then run Gemini transcription, then delete the file.
async function handleTranscribe(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { fileUri, fileName, language, mimeType } = body;
  const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";

  // ── Poll until the file is ACTIVE ──────────────────────────────────────────
  const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
  let fileState = "PROCESSING";

  for (let attempt = 0; attempt < 60; attempt++) {
    const checkRes = await fetch(checkUrl);
    if (checkRes.ok) {
      const meta = await checkRes.json();
      fileState = meta.file?.state || meta.state || "ACTIVE";
      if (fileState === "ACTIVE") break;
      if (fileState === "FAILED") {
        return json(500, { error: "Gemini media file processing failed on Google's servers." });
      }
    }
    // Wait 2 s between polls (wall-clock time, not CPU time — safe in Workers)
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (fileState !== "ACTIVE") {
    return json(500, { error: "Timeout: the media file is still processing on Google's servers." });
  }

  // ── Run Gemini transcription ───────────────────────────────────────────────
  const promptText = `Transcribe the uploaded media file precisely in the language: ${language || "my"}.
Diarize the audio by detecting separate speakers and labeling them (e.g. Speaker 1, Speaker 2).
Output the final transcript as a structured JSON object according to the response schema.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  const genRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { fileData: { mimeType, fileUri } },
            { text: promptText },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            text: { type: "STRING", description: "Full plain text transcript." },
            cues: {
              type: "ARRAY",
              description: "Timestamped segments.",
              items: {
                type: "OBJECT",
                properties: {
                  start: { type: "NUMBER", description: "Start time in seconds." },
                  speaker: { type: "STRING", description: "Speaker label." },
                  text: { type: "STRING", description: "Spoken text." },
                },
                required: ["start", "speaker", "text"],
              },
            },
          },
          required: ["text", "cues"],
        },
      },
    }),
  });

  const raw = await genRes.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: { message: raw } };
  }

  if (!genRes.ok) {
    return json(genRes.status, { error: data.error?.message || "Gemini transcription request failed." });
  }

  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { text: responseText, cues: [] };
  }

  // ── Cleanup: delete the file from Google's storage ─────────────────────────
  fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
    { method: "DELETE" }
  ).catch(() => {});

  return json(200, {
    text: parsed.text || "",
    cues: Array.isArray(parsed.cues) ? parsed.cues : [],
  });
}

// ─── /api/chat ────────────────────────────────────────────────────────────────
async function handleChat(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { transcript, notes, message, history } = body;
  const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";

  const systemPrompt = `You are "Transcript Studio Brain", an expert AI editor and video content analyst.
You help users review video transcripts, extract insights, draft summaries, generate chapters/timelines, find compelling pull quotes, and write social media copy.

Here is the current project context:
---
[PROJECT NOTES]
${notes || "(No notes yet)"}
---
[VIDEO TRANSCRIPT]
${transcript || "(No transcript yet)"}
---

INSTRUCTIONS:
1. Provide highly structured, clear, and action-oriented answers.
2. Use markdown formatting (headers, bold, lists, blockquotes) to make your response visually compelling.
3. Be direct, concise, and professional. Avoid meta-commentary.
4. Use timeline format [MM:SS] if asked to create chapters.`;

  const contents = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (h.role && h.text) {
        contents.push({
          role: h.role === "assistant" ? "model" : h.role,
          parts: [{ text: h.text }],
        });
      }
    }
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.3 },
    }),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: { message: raw } };
  }

  if (!res.ok) {
    return json(res.status, { error: data.error?.message || "Gemini chat request failed." });
  }

  return json(200, {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
  });
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (request.method === "POST") {
      if (url.pathname === "/api/upload-session") return handleUploadSession(request, env);
      if (url.pathname === "/api/transcribe")     return handleTranscribe(request, env);
      if (url.pathname === "/api/chat")           return handleChat(request, env);
    }

    // Health check
    return new Response("Transcript Studio Worker is running ✓", {
      status: 200,
      headers: { "Content-Type": "text/plain", ...CORS },
    });
  },
};
