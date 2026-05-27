/**
 * Transcript Studio — Cloudflare Worker
 *
 * This worker is the only place that knows the GEMINI_API_KEY.
 * The key is stored as a Cloudflare secret (never in source code or git).
 *
 * Endpoints:
 *   POST /api/auth/login      → authenticates a user (username + password)
 *   POST /api/auth/register   → registers a new user
 *   POST /api/upload-session  → starts a Google resumable upload, returns { uploadUrl }
 *   POST /api/transcribe      → polls file state + runs Gemini transcription
 *   POST /api/chat            → runs Gemini chat with transcript context
 *
 * Auth secrets (set via: wrangler secret put <NAME>):
 *   ADMIN_USERNAME   — the allowed login username (default: "richard")
 *   ADMIN_PASSWORD   — the plaintext password for that user
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Goog-Upload-Command, X-Goog-Upload-Offset",
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// ─── Simple SHA-256 hash helper (Web Crypto, available in Workers) ─────────────
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── /api/auth/login ──────────────────────────────────────────────────────────
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { username, password } = body;
  if (!username || !password) {
    return json(400, { error: "Username and password are required." });
  }

  // The allowed user is stored in Worker secrets.
  // If not configured, fall back to a safe default that still requires a password.
  const adminUsername = (env.ADMIN_USERNAME || "richard").toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD || "";

  if (!adminPassword) {
    return json(500, { error: "Server auth is not configured. Set ADMIN_PASSWORD via: wrangler secret put ADMIN_PASSWORD" });
  }

  if (username.trim().toLowerCase() !== adminUsername) {
    return json(401, { error: "Invalid username or password." });
  }

  const inputHash = await sha256(password);
  const storedHash = await sha256(adminPassword);

  if (inputHash !== storedHash) {
    return json(401, { error: "Invalid username or password." });
  }

  return json(200, { success: true, username: env.ADMIN_USERNAME || "Richard" });
}

// ─── /api/auth/register ───────────────────────────────────────────────────────
// On the live Worker, registration is not supported (single-user mode).
// Return a helpful message directing users to update secrets instead.
async function handleRegister(request, env) {
  return json(403, { error: "Account registration is disabled on the live site. To change credentials, update the ADMIN_USERNAME and ADMIN_PASSWORD Worker secrets." });
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

// ─── /api/upload-proxy ────────────────────────────────────────────────────────
// Proxy the file upload request to Google to bypass browser CORS restrictions.
async function handleUploadProxy(request, env) {
  const url = new URL(request.url);
  const uploadUrl = url.searchParams.get("uploadUrl");
  if (!uploadUrl) {
    return json(400, { error: "Missing uploadUrl parameter." });
  }

  const headers = {
    "X-Goog-Upload-Offset": request.headers.get("X-Goog-Upload-Offset") || "0",
    "X-Goog-Upload-Command": request.headers.get("X-Goog-Upload-Command") || "upload, finalize",
    "X-Goog-Upload-Protocol": request.headers.get("X-Goog-Upload-Protocol") || "resumable",
    "Content-Type": request.headers.get("Content-Type") || "application/octet-stream",
  };

  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    headers["Content-Length"] = contentLength;
  }

  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers,
      body: request.body, // Directly stream request body in CF worker!
    });

    const resText = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(resText);
    } catch {
      parsed = { text: resText };
    }

    return json(response.status, parsed);
  } catch (err) {
    return json(500, { error: `Upload proxy failed: ${err.message}` });
  }
}

// ─── /api/file-status ────────────────────────────────────────────────────────
// Check the status of a file on Google's servers.
async function handleFileStatus(request, env) {
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

  const { fileName } = body;
  if (!fileName) {
    return json(400, { error: "fileName is required." });
  }

  const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
  try {
    const checkRes = await fetch(checkUrl);
    if (!checkRes.ok) {
      return json(checkRes.status, { error: `Failed to check file status: ${await checkRes.text()}` });
    }
    const meta = await checkRes.json();
    const fileState = meta.file?.state || meta.state || "ACTIVE";
    return json(200, { state: fileState });
  } catch (err) {
    return json(500, { error: `Failed to fetch file status: ${err.message}` });
  }
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

  const { fileUri, fileName, language, mimeType, speakerMode } = body;
  const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";

  // ── (File polling is done on the client-side to prevent Cloudflare 524 timeouts) ──────────
  // ── Run Gemini transcription ───────────────────────────────────────────────
  let speakerInstructions = "";
  if (speakerMode === "1") {
    speakerInstructions = "This media features exactly 1 speaker. Do NOT diarize. Label all segments under the same speaker name.";
  } else if (speakerMode && speakerMode !== "auto") {
    speakerInstructions = `Diarize the audio by detecting separate speakers. There are exactly ${speakerMode} speakers in this audio. Label them precisely (e.g. Speaker 1, Speaker 2, ..., Speaker ${speakerMode}). Do not merge separate speakers, and do not create more than ${speakerMode} speaker labels.`;
  } else {
    speakerInstructions = "Diarize the audio by detecting separate speakers and labeling them (e.g. Speaker 1, Speaker 2). Detect up to 20 speakers if present in the audio.";
  }

  const promptText = `Transcribe the uploaded media file precisely in the language: ${language || "my"}.
${speakerInstructions}
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

  const { transcript, notes, message, history, username } = body;
  const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";

  const userGreeting = username 
    ? `You are chatting with the user: "${username}". Address them politely by name when appropriate (e.g. at the start of a conversation or when summarizing insights), keep track of their project context, and tailor recommendations to their needs.`
    : "";

  const systemPrompt = `You are "Transcript Studio Brain", an expert AI editor and video content analyst.
You help users review video transcripts, extract insights, draft summaries, generate chapters/timelines, find compelling pull quotes, and write social media copy.

${userGreeting}

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
      if (url.pathname === "/api/auth/login")     return handleLogin(request, env);
      if (url.pathname === "/api/auth/register")  return handleRegister(request, env);
      if (url.pathname === "/api/upload-session") return handleUploadSession(request, env);
      if (url.pathname === "/api/upload-proxy")   return handleUploadProxy(request, env);
      if (url.pathname === "/api/file-status")    return handleFileStatus(request, env);
      if (url.pathname === "/api/transcribe")     return handleTranscribe(request, env);
      if (url.pathname === "/api/chat")           return handleChat(request, env);
    }

    // Health check / unknown routes
    return new Response("Transcript Studio Worker is running ✓", {
      status: 200,
      headers: { "Content-Type": "text/plain", ...CORS },
    });
  },
};
