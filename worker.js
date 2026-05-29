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
  "Access-Control-Allow-Headers": "Content-Type, X-Goog-Upload-Command, X-Goog-Upload-Offset, X-Goog-Upload-Protocol, X-Goog-Upload-Content-Type",
  "Access-Control-Max-Age": "86400",
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

function getGeminiApiKeys(env) {
  const raw = env.GEMINI_API_KEY || "";
  const suspendedKeys = [];
  return raw.split(/[,;]/)
    .map(k => k.trim())
    .filter(k => k && !suspendedKeys.includes(k));
}

async function cleanupZombieFiles(apiKey) {
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/files?key=${apiKey}`;
    const listRes = await fetch(listUrl);
    if (!listRes.ok) return;

    const data = await listRes.json();
    if (!data || !data.files || data.files.length === 0) return;

    const now = Date.now();
    let totalSizeBytes = 0;
    const fileList = [];

    for (const f of data.files) {
      const sizeBytes = parseInt(f.sizeBytes || "0", 10);
      const createTimeMs = new Date(f.createTime).getTime();
      totalSizeBytes += sizeBytes;
      fileList.push({
        name: f.name,
        displayName: f.displayName,
        sizeBytes,
        createTimeMs,
        ageMs: now - createTimeMs
      });
    }

    console.log(`[Storage Manager] Current total storage: ${(totalSizeBytes / 1024 / 1024 / 1024).toFixed(3)} GB`);

    // Guard 1: Clean up any files older than 10 minutes immediately
    for (const f of fileList) {
      if (f.ageMs > 10 * 60 * 1000) {
        console.log(`[Cleanup] Deleting file older than 10 mins: ${f.name} (${f.displayName}, size: ${(f.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
        await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}?key=${apiKey}`, {
          method: "DELETE"
        }).catch(() => {});
        totalSizeBytes -= f.sizeBytes;
      }
    }

    // Guard 2: If total storage STILL exceeds 15 GB, delete oldest files first until it is under 10 GB
    const LIMIT_15_GB = 15 * 1024 * 1024 * 1024;
    const SAFE_10_GB = 10 * 1024 * 1024 * 1024;

    if (totalSizeBytes > LIMIT_15_GB) {
      console.warn(`[Storage Manager] Storage warning: ${(totalSizeBytes / 1024 / 1024 / 1024).toFixed(3)} GB exceeds 15 GB limit. Deleting oldest files...`);
      
      // Sort oldest files first
      const remainingFiles = fileList.filter(f => f.ageMs <= 10 * 60 * 1000)
        .sort((a, b) => a.createTimeMs - b.createTimeMs);

      for (const f of remainingFiles) {
        if (totalSizeBytes <= SAFE_10_GB) break;

        console.log(`[Cleanup] Deleting oldest active file to free up space: ${f.name} (${f.displayName}, size: ${(f.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
        await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}?key=${apiKey}`, {
          method: "DELETE"
        }).catch(() => {});
        totalSizeBytes -= f.sizeBytes;
      }
    }

    console.log(`[Storage Manager] Post-cleanup storage size: ${(totalSizeBytes / 1024 / 1024 / 1024).toFixed(3)} GB`);
  } catch (err) {
    console.error("[Cleanup] Storage quota manager error:", err);
  }
}

// ─── /api/upload-session ──────────────────────────────────────────────────────
// The browser asks us to start a resumable upload with Google.
// We call Google using our secret key, then return only the session URL.
// The session URL does NOT contain the API key — it is safe to send to the browser.
async function handleUploadSession(request, env, ctx) {
  const keys = getGeminiApiKeys(env);
  if (keys.length === 0) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker. Add it via: wrangler secret put GEMINI_API_KEY" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { fileName, fileSize, mimeType, startKeyIndex } = body;

  let startIndex = 0;
  if (startKeyIndex !== undefined && startKeyIndex !== null) {
    const parsedIdx = parseInt(startKeyIndex, 10);
    if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < keys.length) {
      startIndex = parsedIdx;
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const i = (startIndex + attempt) % keys.length;
    const apiKey = keys[i];
    console.log(`[Worker UploadSession] Trying API key index ${i}...`);
    try {
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

      const raw = await initRes.text();
      if (initRes.ok) {
        const uploadUrl = initRes.headers.get("x-goog-upload-url") || initRes.headers.get("X-Goog-Upload-URL");
        if (uploadUrl) {
          console.log(`[Worker UploadSession] Success with key index ${i}`);
          
          // Trigger async zombie file cleanup in the background (non-blocking, memory safe!)
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(cleanupZombieFiles(apiKey));
          } else {
            cleanupZombieFiles(apiKey).catch(err => console.error("[Cleanup] Async cleanup error:", err));
          }

          return json(200, { uploadUrl, keyIndex: i });
        }
      }
      console.warn(`[Worker UploadSession] Key index ${i} failed with status ${initRes.status}: ${raw}`);
      lastError = new Error(`Key ${i} failed (status ${initRes.status}): ${raw}`);
    } catch (err) {
      console.warn(`[Worker UploadSession] Key index ${i} error:`, err);
      lastError = err;
    }
  }

  return json(500, { error: `All API keys failed to start upload session. Last error: ${lastError ? lastError.message : "Unknown"}` });
}

// ─── /api/upload-proxy ────────────────────────────────────────────────────────
// Fallback proxy for upload chunks when browser can't upload directly to Google.
// Streams the request body straight through to Google — no RAM buffering.
async function handleUploadProxy(request, env) {
  const url = new URL(request.url);
  const uploadUrl = url.searchParams.get("uploadUrl");
  if (!uploadUrl) {
    return json(400, { error: "Missing uploadUrl parameter." });
  }

  const headers = {
    "X-Goog-Upload-Offset": request.headers.get("X-Goog-Upload-Offset") || "0",
    "X-Goog-Upload-Command": request.headers.get("X-Goog-Upload-Command") || "upload, finalize",
    "X-Goog-Upload-Protocol": "resumable",
    "Content-Type": request.headers.get("Content-Type") || "application/octet-stream",
  };

  // Pass Content-Length through if the browser sent it (important for Google's resumable protocol)
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;

  try {
    // ── Stream directly: Worker body → Google (zero RAM buffering) ──
    // Cloudflare Workers support streaming fetch bodies natively.
    // This is safe for 64 MB+ chunks without hitting the 128 MB memory cap.
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers,
      body: request.body, // stream passthrough — no arrayBuffer()
    });

    const resText = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(resText);
    } catch {
      parsed = { text: resText };
    }

    let responseStatus = response.status;
    if (responseStatus === 308) {
      responseStatus = 200; // Map 308 → 200 so browser fetch doesn't treat it as a redirect error
    }
    return json(responseStatus, parsed);
  } catch (err) {
    return json(500, { error: `Upload proxy failed: ${err.message}` });
  }
}

// ─── /api/file-status ────────────────────────────────────────────────────────
// Check the status of a file on Google's servers.
async function handleFileStatus(request, env) {
  const keys = getGeminiApiKeys(env);
  if (keys.length === 0) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { fileName, keyIndex } = body;
  if (!fileName) {
    return json(400, { error: "fileName is required." });
  }

  let idx = 0;
  if (keyIndex !== undefined && keyIndex !== null) {
    const parsedIdx = parseInt(keyIndex, 10);
    if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < keys.length) {
      idx = parsedIdx;
    }
  }

  const apiKey = keys[idx];
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

// ─── Simple parser to convert plain text bracketed transcripts to cues ───────
function parseTranscriptToCues(text, defaultSpeaker = "Speaker") {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const cues = [];
  
  for (const line of lines) {
    const timeMatch = line.match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*(.*)$/);
    if (!timeMatch) continue;
    
    const timeStr = timeMatch[1];
    const body = timeMatch[2].trim();
    
    const parts = timeStr.split(":").map(Number);
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else {
      seconds = parts[0] || 0;
    }
    
    const speakerMatch = body.match(/^([^:]{1,32}):\s*(.*)$/);
    const speaker = speakerMatch ? speakerMatch[1].trim() : defaultSpeaker;
    const spokenText = speakerMatch ? speakerMatch[2].trim() : body;
    
    if (spokenText) {
      cues.push({ start: seconds, speaker, text: spokenText });
    }
  }
  return cues;
}

// ─── /api/transcribe-stream ───────────────────────────────────────────────────
// Streaming version of /api/transcribe. Returns SSE events so the browser
// can render transcript cues in real time instead of waiting for full inference.
async function handleTranscribeStream(request, env, ctx) {
  const keys = getGeminiApiKeys(env);
  if (keys.length === 0) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker." });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const { fileUri, fileName, language, mimeType, speakerMode, geminiModel: reqModel, keyIndex, inlineData } = body;
  const geminiModel = reqModel || env.GEMINI_MODEL || "gemini-3.5-flash";

  let idx = 0;
  if (keyIndex !== undefined && keyIndex !== null) {
    const p = parseInt(keyIndex, 10);
    if (!isNaN(p) && p >= 0 && p < keys.length) idx = p;
  }
  const apiKey = keys[idx];

  let speakerInstructions = "";
  if (speakerMode === "1") {
    speakerInstructions = "This media features exactly 1 speaker. Do NOT diarize. Label all segments under the same speaker name.";
  } else if (speakerMode && speakerMode !== "auto") {
    speakerInstructions = `Diarize the audio by detecting separate speakers. There are exactly ${speakerMode} speakers. Label them precisely. Do not create more than ${speakerMode} speaker labels.`;
  } else {
    speakerInstructions = "Diarize the audio by detecting separate speakers (e.g. Speaker 1, Speaker 2). Detect up to 20 speakers if present.";
  }

  const promptText = `Transcribe the uploaded media file precisely in the language: ${language || "my"}.
${speakerInstructions}
Output the final transcript as a plain-text list of timestamped segments in the exact format:
[MM:SS] Speaker Name: Spoken text
Example:
[00:00] Speaker 1: Hello and welcome.
[00:04] Speaker 2: Hi everyone.`;

  const encoder = new TextEncoder();

  // Cloudflare Workers support streaming ReadableStream responses natively.
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        if (inlineData) {
          // ── Inline Data Path: Bypass all Files API upload/activation logic ──
          sendEvent({ type: "activating", elapsed: 0, ready: true });
          
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
          const genRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { inlineData: { mimeType: inlineData.mimeType, data: inlineData.data } },
                  { text: promptText },
                ],
              }],
            }),
          });

          if (!genRes.ok) {
            const errText = await genRes.text();
            let errData;
            try { errData = JSON.parse(errText); } catch { errData = { error: { message: errText } }; }
            sendEvent({ type: "error", error: errData.error?.message || "Gemini API error" });
            controller.close();
            return;
          }

          const reader = genRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let fullText = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const obj = JSON.parse(line.slice(6));
                const chunk = obj.candidates?.[0]?.content?.parts?.[0]?.text || "";
                if (chunk) { fullText += chunk; sendEvent({ type: "chunk", text: chunk }); }
              } catch {}
            }
          }

          const cues = parseTranscriptToCues(fullText);
          sendEvent({ type: "done", text: fullText, cues });
          controller.close();
          return;
        }

        // ── Files API Path ──
        sendEvent({ type: "activating", elapsed: 0 });
        let activationAttempt = 0;
        while (activationAttempt < 600) {
          await new Promise((r) => setTimeout(r, 500));
          const statusRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
            { method: "GET" }
          );
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.state === "ACTIVE") break;
            if (statusData.state === "FAILED") {
              sendEvent({ type: "error", error: "Google failed to process the media file." });
              controller.close();
              return;
            }
          }
          activationAttempt++;
          if (activationAttempt % 4 === 0) {
            sendEvent({ type: "activating", elapsed: Math.round(activationAttempt * 0.5) });
          }
        }
        if (activationAttempt >= 600) {
          sendEvent({ type: "error", error: "Timeout: Google took over 5 minutes to process your media." });
          controller.close();
          return;
        }
        sendEvent({ type: "activating", elapsed: Math.round(activationAttempt * 0.5), ready: true });

        // File is ACTIVE \u2014 immediately start streaming transcription
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
        const genRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { fileData: { mimeType, fileUri } },
                { text: promptText },
              ],
            }],
          }),
        });

        if (!genRes.ok) {
          const errText = await genRes.text();
          let errData;
          try { errData = JSON.parse(errText); } catch { errData = { error: { message: errText } }; }
          sendEvent({ type: "error", error: errData.error?.message || "Gemini API error" });
          controller.close();
          return;
        }

        const reader = genRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const obj = JSON.parse(line.slice(6));
              const chunk = obj.candidates?.[0]?.content?.parts?.[0]?.text || "";
              if (chunk) { fullText += chunk; sendEvent({ type: "chunk", text: chunk }); }
            } catch {}
          }
        }

        const cues = parseTranscriptToCues(fullText);
        sendEvent({ type: "done", text: fullText, cues });

        // Cleanup in background after response is sent
        const deletePromise = fetch(
          `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
          { method: "DELETE" }
        ).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(deletePromise);

      } catch (err) {
        sendEvent({ type: "error", error: err.message });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS },
  });
}

// ─── /api/transcribe ──────────────────────────────────────────────────────────
// After the browser uploads the file directly to Google, it sends us
// { fileUri, fileName, language, mimeType }.
// We run Gemini transcription and delete the file.
async function handleTranscribe(request, env, ctx) {
  const keys = getGeminiApiKeys(env);
  if (keys.length === 0) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { fileUri, fileName, language, mimeType, speakerMode, geminiModel: reqModel, keyIndex } = body;
  const geminiModel = reqModel || env.GEMINI_MODEL || "gemini-2.5-flash";

  let idx = 0;
  if (keyIndex !== undefined && keyIndex !== null) {
    const parsedIdx = parseInt(keyIndex, 10);
    if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < keys.length) {
      idx = parsedIdx;
    }
  }
  const apiKey = keys[idx];

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
Output the final transcript as a plain-text list of timestamped segments in the exact format:
[MM:SS] Speaker Name: Spoken text
Example:
[00:00] Speaker 1: Hello and welcome.
[00:04] Speaker 2: Hi everyone.`;

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

  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cues = parseTranscriptToCues(responseText);

  // ── Cleanup: delete the file from Google's storage (non-blocking, memory safe) ──
  const deletePromise = fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
    { method: "DELETE" }
  ).catch(() => {});

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(deletePromise);
  }

  return json(200, {
    text: responseText,
    cues: cues,
  });
}

// ─── /api/chat ────────────────────────────────────────────────────────────────
async function handleChat(request, env) {
  const keys = getGeminiApiKeys(env);
  if (keys.length === 0) {
    return json(500, { error: "GEMINI_API_KEY is not configured in this Worker." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { transcript, notes, message, history, username, geminiModel: reqModel, keyIndex } = body;
  const geminiModel = reqModel || env.GEMINI_MODEL || "gemini-2.5-flash";

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

  let startIndex = 0;
  if (keyIndex !== undefined && keyIndex !== null) {
    const parsedIdx = parseInt(keyIndex, 10);
    if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < keys.length) {
      startIndex = parsedIdx;
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (startIndex + attempt) % keys.length;
    const apiKey = keys[idx];
    console.log(`[Worker Chat] Trying API key index ${idx}...`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

    try {
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

      if (res.ok) {
        console.log(`[Worker Chat] Success with key index ${idx}`);
        return json(200, {
          text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
          keyIndex: idx
        });
      }

      console.warn(`[Worker Chat] Key index ${idx} failed with status ${res.status}: ${data.error?.message || raw}`);
      lastError = new Error(`Key ${idx} failed (status ${res.status}): ${data.error?.message || raw}`);
    } catch (err) {
      console.warn(`[Worker Chat] Key index ${idx} error:`, err);
      lastError = err;
    }
  }

  return json(500, { error: `All API keys failed for chat. Last error: ${lastError ? lastError.message : "Unknown"}` });
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (request.method === "POST") {
      if (url.pathname === "/api/auth/login")     return handleLogin(request, env);
      if (url.pathname === "/api/auth/register")  return handleRegister(request, env);
      if (url.pathname === "/api/upload-session") return handleUploadSession(request, env, ctx);
      if (url.pathname === "/api/upload-proxy")   return handleUploadProxy(request, env);
      if (url.pathname === "/api/file-status")    return handleFileStatus(request, env);
      if (url.pathname === "/api/transcribe")        return handleTranscribe(request, env, ctx);
      if (url.pathname === "/api/transcribe-stream")  return handleTranscribeStream(request, env, ctx);
      if (url.pathname === "/api/chat")           return handleChat(request, env);
    }

    // Health check / unknown routes
    return new Response("Transcript Studio Worker is running ✓", {
      status: 200,
      headers: { "Content-Type": "text/plain", ...CORS },
    });
  },
};
