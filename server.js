const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const util = require("node:util");
const exec = util.promisify(cp.exec);

const root = path.normalize(__dirname);
const safeRoot = root.endsWith(path.sep) ? root : root + path.sep;

const usersFilePath = path.normalize(path.join(root, "users.json"));
if (!usersFilePath.startsWith(safeRoot)) {
  throw new Error("Security violation: invalid users path");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function readUsers() {
  try {
    const content = await fs.readFile(usersFilePath, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeUsers(users) {
  await fs.writeFile(usersFilePath, JSON.stringify(users, null, 2), "utf8");
}

async function handleRegister(req, res) {
  try {
    const { username, password } = await parseJson(req);
    if (!username || !password) {
      sendJson(res, 400, { error: "Username and password are required." });
      return;
    }
    const cleanUsername = String(username).trim();
    if (cleanUsername.length < 2) {
      sendJson(res, 400, { error: "Username must be at least 2 characters long." });
      return;
    }
    const users = await readUsers();
    const lowerUser = cleanUsername.toLowerCase();
    if (users[lowerUser]) {
      sendJson(res, 400, { error: "Username is already taken." });
      return;
    }
    users[lowerUser] = {
      username: cleanUsername,
      passwordHash: hashPassword(password),
      createdAt: Date.now()
    };
    await writeUsers(users);
    sendJson(res, 200, { success: true, username: cleanUsername });
  } catch (err) {
    sendJson(res, 500, { error: "Server registration error: " + err.message });
  }
}

async function handleLogin(req, res) {
  try {
    const { username, password } = await parseJson(req);
    if (!username || !password) {
      sendJson(res, 400, { error: "Username and password are required." });
      return;
    }
    const cleanUsername = String(username).trim();
    const users = await readUsers();
    const lowerUser = cleanUsername.toLowerCase();
    const user = users[lowerUser];
    if (!user || user.passwordHash !== hashPassword(password)) {
      sendJson(res, 401, { error: "Invalid username or password." });
      return;
    }
    sendJson(res, 200, { success: true, username: user.username });
  } catch (err) {
    sendJson(res, 500, { error: "Server login error: " + err.message });
  }
}
const port = Number(process.env.PORT || 4173);
const model = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize";
const maxUploadBytes = 1024 * 1024 * 1024; // Increased to 1 GB to support larger video uploads

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function loadLocalEnv() {
  const joinedPath = path.join(root, ".env.local");
  const fullPath = path.normalize(joinedPath);
  if (!fullPath.startsWith(safeRoot)) {
    return;
  }
  try {
    const content = await fs.readFile(fullPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || Reflect.has(process.env, match[1])) continue;
      Reflect.set(process.env, match[1], match[2].replace(/^['"]|['"]$/g, ""));
    }
  } catch {
    // .env.local is optional; environment variables still work.
  }
}

async function getGcloudAccessToken() {
  try {
    const { stdout } = await exec("gcloud auth application-default print-access-token");
    const token = stdout.trim();
    if (token) return { token, type: "adc" };
  } catch (err) {
    console.warn("[Auth] Failed to get application-default token, trying standard gcloud auth...");
  }

  try {
    const { stdout } = await exec("gcloud auth print-access-token");
    const token = stdout.trim();
    if (token) return { token, type: "gcloud" };
  } catch (err) {
    console.error("[Auth] Both gcloud token methods failed:", err);
  }

  return null;
}

function getGeminiApiKeys() {
  const raw = process.env.GEMINI_API_KEY || "";
  const suspendedKeys = [];
  return raw.split(/[,;]/)
    .map(k => k.trim())
    .filter(k => k && !suspendedKeys.includes(k));
}

async function resolveAuth(reqBodyOrIndex) {
  const keys = getGeminiApiKeys();
  if (keys.length > 0) {
    let index = 0;
    if (reqBodyOrIndex !== undefined && reqBodyOrIndex !== null) {
      if (typeof reqBodyOrIndex === "object" && reqBodyOrIndex.keyIndex !== undefined) {
        index = parseInt(reqBodyOrIndex.keyIndex, 10);
      } else if (typeof reqBodyOrIndex === "number" || typeof reqBodyOrIndex === "string") {
        index = parseInt(reqBodyOrIndex, 10);
      }
    }
    if (isNaN(index) || index < 0 || index >= keys.length) {
      index = 0;
    }
    const key = keys[index];
    return {
      type: "key",
      key,
      headers: {},
      queryParam: `?key=${key}`,
      keyIndex: index,
    };
  }

  const gcloudTokenObj = await getGcloudAccessToken();
  if (gcloudTokenObj && gcloudTokenObj.token) {
    return {
      type: "token",
      token: gcloudTokenObj.token,
      headers: {
        "Authorization": `Bearer ${gcloudTokenObj.token}`,
      },
      queryParam: "",
      keyIndex: 0,
    };
  }

  return null;
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

async function handleUploadSession(req, res) {
  try {
    const body = await parseJson(req);
    const { fileName, fileSize, mimeType, startKeyIndex } = body;

    console.log(`[UploadSession] Initiating upload for file: ${fileName} (${fileSize} bytes)`);

    const keys = getGeminiApiKeys();
    if (keys.length === 0) {
      const auth = await resolveAuth();
      if (!auth) {
        sendJson(res, 500, {
          error: "Authentication failed. Set GEMINI_API_KEY in .env.local or authenticate via: gcloud auth application-default login",
          isAuthMissing: true,
        });
        return;
      }

      const initRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files${auth.queryParam}`,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(fileSize),
            "X-Goog-Upload-Header-Content-Type": mimeType,
            "Content-Type": "application/json",
            ...auth.headers
          },
          body: JSON.stringify({ file: { display_name: fileName || "media" } }),
        }
      );

      const raw = await initRes.text();
      if (!initRes.ok) {
        throw new Error(raw);
      }
      const uploadUrl = initRes.headers.get("x-goog-upload-url") || initRes.headers.get("X-Goog-Upload-URL");
      if (!uploadUrl) {
        throw new Error("No upload URL returned from Gemini Files API.");
      }
      sendJson(res, 200, { uploadUrl, keyIndex: 0 });
      return;
    }

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
      const key = keys[i];
      console.log(`[UploadSession] Trying API key index ${i}...`);
      try {
        const initRes = await fetch(
          `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`,
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
            console.log(`[UploadSession] Success with key index ${i}`);
            
            // Trigger async zombie file and storage quota cleanup in the background
            cleanupZombieFiles(key).catch(err => console.error("[Cleanup] Async cleanup error:", err));

            sendJson(res, 200, { uploadUrl, keyIndex: i });
            return;
          }
        }
        console.warn(`[UploadSession] Key index ${i} failed: status ${initRes.status}, response: ${raw}`);
        lastError = new Error(`Key ${i} failed (status ${initRes.status}): ${raw}`);
      } catch (err) {
        console.warn(`[UploadSession] Key index ${i} error:`, err);
        lastError = err;
      }
    }

    sendJson(res, 500, { error: `All API keys failed to start upload session. Last error: ${lastError ? lastError.message : "Unknown"}` });
  } catch (err) {
    sendJson(res, 500, { error: `Upload session initiation error: ${err.message}` });
  }
}

async function handleUploadProxy(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const uploadUrl = url.searchParams.get("uploadUrl");
    if (!uploadUrl) {
      sendJson(res, 400, { error: "Missing uploadUrl parameter." });
      return;
    }

    console.log(`[UploadProxy] Buffering and proxying upload to: ${uploadUrl}`);

    const headers = {
      "X-Goog-Upload-Offset": req.headers["x-goog-upload-offset"] || "0",
      "X-Goog-Upload-Command": req.headers["x-goog-upload-command"] || "upload, finalize",
      "X-Goog-Upload-Protocol": req.headers["x-goog-upload-protocol"] || "resumable",
      "Content-Type": req.headers["content-type"] || "application/octet-stream",
    };

    console.log("[UploadProxy] Incoming Headers:", req.headers);
    console.log("[UploadProxy] Constructed Headers for Google:", headers);

    // Buffer the incoming Node.js request body stream into a single memory Buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    headers["Content-Length"] = String(buffer.length);

    console.log(`[UploadProxy] Buffered ${buffer.length} bytes. Sending to Google...`);

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers,
      body: buffer,
    });

    const resText = await response.text();
    console.log(`[UploadProxy] Google response status: ${response.status}, body: ${resText}`);
    let parsed;
    try {
      parsed = JSON.parse(resText);
    } catch {
      parsed = { text: resText };
    }

    let responseStatus = response.status;
    if (responseStatus === 308) {
      responseStatus = 200; // Map 308 to 200 to prevent browser fetch redirect errors
    }
    sendJson(res, responseStatus, parsed);
  } catch (err) {
    console.error("[UploadProxy] Error proxying upload:", err);
    sendJson(res, 500, { error: `Upload proxy error: ${err.message}` });
  }
}

async function handleFileStatus(req, res) {
  try {
    const body = await parseJson(req);
    const { fileName } = body;
    if (!fileName) {
      sendJson(res, 400, { error: "fileName is required." });
      return;
    }

    const auth = await resolveAuth(body);
    if (!auth) {
      sendJson(res, 500, {
        error: "Authentication failed. Set GEMINI_API_KEY in .env.local or authenticate via: gcloud auth application-default login",
        isAuthMissing: true,
      });
      return;
    }

    const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}${auth.queryParam}`;
    const checkRes = await fetch(checkUrl, { headers: { ...auth.headers } });
    if (!checkRes.ok) {
      sendJson(res, checkRes.status, { error: `Failed to check file status: ${await checkRes.text()}` });
      return;
    }

    const meta = await checkRes.json();
    const fileState = meta.file?.state || meta.state || "ACTIVE";
    sendJson(res, 200, { state: fileState });
  } catch (err) {
    console.error("[FileStatus] Error checking file status:", err);
    sendJson(res, 500, { error: `File status error: ${err.message}` });
  }
}


function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function languageCode(value) {
  const [code] = String(value || "my-MM").split("-");
  return code || "my";
}

function splitTranscript(text) {
  const parts = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[။.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = parts.length ? parts : [String(text || "").trim()].filter(Boolean);
  return chunks.map((chunk, index) => ({
    start: index * 8,
    speaker: "Speaker",
    text: chunk,
  }));
}

async function parseForm(req) {
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });
  return request.formData();
}

async function parseJson(req) {
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });
  return request.json();
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

async function transcribeStream(req, res) {
  try {
    const body = await parseJson(req);
    const { fileUri, fileName, language, mimeType, speakerMode, geminiModel: reqModel, keyIndex } = body;

    const auth = await resolveAuth({ keyIndex });
    if (!auth) {
      sendJson(res, 500, {
        error: "Authentication failed. Set GEMINI_API_KEY in .env.local or run: gcloud auth application-default login",
        isAuthMissing: true,
      });
      return;
    }

    const geminiModel = reqModel || process.env.GEMINI_MODEL || "gemini-3.5-flash";
    console.log(`[TranscribeStream] uri=${fileUri} model=${geminiModel} lang=${language}`);

    let speakerInstructions = "";
    if (speakerMode === "1") {
      speakerInstructions = "This media features exactly 1 speaker. Do NOT diarize. Label all segments under the same speaker name.";
    } else if (speakerMode && speakerMode !== "auto") {
      speakerInstructions = `Diarize the audio by detecting separate speakers. There are exactly ${speakerMode} speakers. Label them precisely (e.g. Speaker 1, Speaker 2). Do not create more than ${speakerMode} speaker labels.`;
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

    // Set SSE headers before any async work that could fail
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",  // prevent nginx buffering
    });

    const sendEvent = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    // ── Server-side activation polling (500ms intervals, zero browser round-trips) ──
    // Polls Google's Files API directly and starts transcription the instant the
    // file flips to ACTIVE. Sends live counter ticks to the client via SSE.
    sendEvent({ type: "activating", elapsed: 0 });
    let activationAttempt = 0;
    while (activationAttempt < 600) { // max 5 min
      await new Promise((r) => setTimeout(r, 500));
      const statusRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}${auth.queryParam}`,
        { method: "GET", headers: { ...auth.headers } }
      );
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.state === "ACTIVE") break;
        if (statusData.state === "FAILED") {
          sendEvent({ type: "error", error: "Google failed to process the media file." });
          res.end();
          return;
        }
      }
      activationAttempt++;
      if (activationAttempt % 4 === 0) { // tick every 2 s
        sendEvent({ type: "activating", elapsed: Math.round(activationAttempt * 0.5) });
      }
    }
    if (activationAttempt >= 600) {
      sendEvent({ type: "error", error: "Timeout: Google took over 5 minutes to process your media." });
      res.end();
      return;
    }
    sendEvent({ type: "activating", elapsed: Math.round(activationAttempt * 0.5), ready: true });

    // File is ACTIVE — immediately start streaming transcription
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent${auth.queryParam}&alt=sse`;

    const genRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
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
      res.end();
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

    // Cleanup: delete file from Google storage in the background
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}${auth.queryParam}`,
      { method: "DELETE", headers: { ...auth.headers } }
    ).catch(() => {});

    res.end();
  } catch (err) {
    console.error("[TranscribeStream] Error:", err);
    try {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
      res.end();
    } catch {}
  }
}

async function transcribe(req, res) {
  let isJson = false;
  if (req.headers["content-type"] && req.headers["content-type"].includes("application/json")) {
    isJson = true;
  }

  if (isJson) {
    try {
      const body = await parseJson(req);
      const { fileUri, fileName, language, mimeType, speakerMode, geminiModel: reqModel, keyIndex } = body;
      
      const auth = await resolveAuth({ keyIndex });
      if (!auth) {
        sendJson(res, 500, {
          error: "Authentication failed. Set GEMINI_API_KEY in .env.local or authenticate via: gcloud auth application-default login",
          isAuthMissing: true,
        });
        return;
      }

      const geminiModel = reqModel || process.env.GEMINI_MODEL || "gemini-2.5-flash";

      console.log(`[Transcribe] Processing file uri: ${fileUri} using model ${geminiModel} (type: ${mimeType}, language: ${language}, speakerMode: ${speakerMode})`);

      // Run Gemini transcription
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

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent${auth.queryParam}`;

      const genRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.headers
        },
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
        if (data.error?.message?.includes("scope") || data.error?.status === "PERMISSION_DENIED") {
          sendJson(res, 403, {
            error: "Google Cloud authentication scope is insufficient.",
            isScopeError: true,
            diagnosticCommand: "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform",
            message: data.error.message
          });
          return;
        }
        throw new Error(data.error?.message || "Gemini transcription request failed.");
      }

      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const cues = parseTranscriptToCues(responseText);

      // Cleanup: delete the file from Google's storage in the background
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}${auth.queryParam}`,
        { method: "DELETE", headers: { ...auth.headers } }
      ).catch(() => {});

      sendJson(res, 200, {
        text: responseText,
        cues: cues,
      });
    } catch (err) {
      console.error(`[Transcribe] Plain text flow error:`, err);
      sendJson(res, 500, { error: err.message || "Transcription failed." });
    }
  } else {
    // Multipart form fallback flow
    try {
      const auth = await resolveAuth();
      if (!auth) {
        sendJson(res, 500, {
          error: "Authentication failed. Set GEMINI_API_KEY in .env.local or authenticate via: gcloud auth application-default login",
          isAuthMissing: true,
        });
        return;
      }

      const form = await parseForm(req);
      const file = form.get("file");
      const language = languageCode(form.get("language"));

      if (!file || typeof file.arrayBuffer !== "function") {
        sendJson(res, 400, { error: "No video file was uploaded." });
        return;
      }

      if (file.size > maxUploadBytes) {
        sendJson(res, 413, {
          error: "This file is larger than 500 MB. Please use a shorter clip or compress/extract the audio first.",
        });
        return;
      }

      const mimeType = file.type || "application/octet-stream";
      const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";

      console.log(`[Transcribe] Processing file upload: ${file.name} (size: ${(file.size / 1024 / 1024).toFixed(2)} MB, type: ${mimeType})`);

      let fileUri = null;
      let fileName = null;

      // 1. Start Resumable Session with Gemini Files API
      console.log(`[Transcribe] Initiating Files API resumable session...`);
      const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files${auth.queryParam}`, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(file.size),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
          ...auth.headers
        },
        body: JSON.stringify({
          file: {
            display_name: file.name || "video.mp4",
          }
        })
      });

      if (!initRes.ok) {
        const errText = await initRes.text();
        let errParsed;
        try { errParsed = JSON.parse(errText); } catch { errParsed = { error: { message: errText } }; }
        if (errParsed.error?.message?.includes("scope") || errParsed.error?.status === "PERMISSION_DENIED") {
          sendJson(res, 403, {
            error: "Google Cloud authentication scope is insufficient.",
            isScopeError: true,
            diagnosticCommand: "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform",
            message: errParsed.error.message
          });
          return;
        }
        throw new Error(`Failed to initiate file upload session: ${errText}`);
      }

      const uploadUrl = initRes.headers.get("x-goog-upload-url") || initRes.headers.get("X-Goog-Upload-URL");
      if (!uploadUrl) {
        throw new Error("No upload URL received from Gemini Files API in headers.");
      }

      // 2. Stream Binary Bytes to Gemini Files API
      console.log(`[Transcribe] Sending raw bytes to Files API session...`);
      const arrayBuffer = await file.arrayBuffer();
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
          "Content-Length": String(file.size),
        },
        body: Buffer.from(arrayBuffer),
      });

      const uploadRaw = await uploadRes.text();
      let fileMeta;
      try {
        fileMeta = JSON.parse(uploadRaw);
      } catch {
        fileMeta = { error: { message: uploadRaw } };
      }

      if (!uploadRes.ok) {
        throw new Error(fileMeta.error?.message || fileMeta.error || "Failed to upload binary file payload to Gemini Files API.");
      }

      fileUri = fileMeta.file?.uri;
      fileName = fileMeta.file?.name;
      if (!fileUri) {
        throw new Error("No file URI received after uploading to Gemini Files API.");
      }

      console.log(`[Transcribe] File uploaded successfully. URI: ${fileUri}, Resource Name: ${fileName}`);

      // 3. Poll file status until it is ACTIVE
      console.log(`[Transcribe] Polling file status to ensure it is fully processed by Google...`);
      let fileState = "PROCESSING";
      const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}${auth.queryParam}`;
      
      for (let attempt = 0; attempt < 30; attempt++) {
        const checkRes = await fetch(checkUrl, { headers: { ...auth.headers } });
        if (checkRes.ok) {
          const checkMeta = await checkRes.json();
          fileState = checkMeta.file?.state || checkMeta.state || "ACTIVE";
          console.log(`[Transcribe] Attempt ${attempt + 1}: state is ${fileState}`);
          if (fileState === "ACTIVE") {
            break;
          }
          if (fileState === "FAILED") {
            throw new Error("Gemini media file processing failed on Google servers.");
          }
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (fileState !== "ACTIVE") {
        throw new Error("Timeout waiting for media file to be processed by Gemini (file is still processing).");
      }

      // 4. Transcribe and Diarize the File
      console.log(`[Transcribe] Generating transcription and diarization via Gemini Model...`);
      const promptText = `Transcribe the uploaded media file precisely in the language: ${language}.
Diarize the audio by detecting separate speakers and labeling them (e.g. Speaker 1, Speaker 2).
Output the final transcript as a structured JSON object according to the response schema.`;

      const payload = {
        contents: [
          {
            parts: [
              {
                fileData: {
                  mimeType: mimeType,
                  fileUri: fileUri
                }
              },
              {
                text: promptText
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              text: {
                type: "STRING",
                description: "The full combined plain text transcript of the media file."
              },
              cues: {
                type: "ARRAY",
                description: "An array of timestamped transcription segments.",
                items: {
                  type: "OBJECT",
                  properties: {
                    start: {
                      type: "NUMBER",
                      description: "The start time of the cue segment in seconds."
                    },
                    speaker: {
                      type: "STRING",
                      description: "The name or label of the speaker."
                    },
                    text: {
                      type: "STRING",
                      description: "The text spoken in this cue segment."
                    }
                  },
                  required: ["start", "speaker", "text"]
                }
              }
            },
            required: ["text", "cues"]
          }
        }
      };

      const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent${auth.queryParam}`;
      const generateRes = await fetch(generateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.headers
        },
        body: JSON.stringify(payload),
      });

      const raw = await generateRes.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: { message: raw } };
      }

      if (!generateRes.ok) {
        if (data.error?.message?.includes("scope") || data.error?.status === "PERMISSION_DENIED") {
          sendJson(res, 403, {
            error: "Google Cloud authentication scope is insufficient.",
            isScopeError: true,
            diagnosticCommand: "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform",
            message: data.error.message
          });
          return;
        }
        sendJson(res, generateRes.status, {
          error: data.error?.message || data.error || "Gemini content generation failed.",
        });
        return;
      }

      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      let parsedResult;
      try {
        parsedResult = JSON.parse(responseText);
      } catch (error) {
        parsedResult = { text: responseText, cues: splitTranscript(responseText) };
      }

      const text = parsedResult.text || "";
      const cues = Array.isArray(parsedResult.cues) ? parsedResult.cues : splitTranscript(text);

      console.log(`[Transcribe] Success! Generated cues: ${cues.length}`);

      sendJson(res, 200, {
        model: geminiModel,
        text,
        cues,
      });

    } catch (err) {
      console.error(`[Transcribe] Error during processing:`, err);
      sendJson(res, 500, {
        error: `Internal server transcription error: ${err.message || err}`,
      });
    } finally {
      // Cleanup uploaded File to keep AI Studio storage clean
      if (fileName) {
        console.log(`[Transcribe] Cleaning up media resource in background: ${fileName}`);
        fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}${auth.queryParam}`, {
          method: "DELETE",
          headers: { ...auth.headers }
        }).catch((e) => {
          console.error(`[Transcribe] Failed to delete media resource ${fileName}:`, e);
        });
      }
    }
  }
}

async function chat(req, res) {
  try {
    const body = await parseJson(req);
    const { transcript, notes, message, history, username, geminiModel: reqModel, keyIndex } = body;

    const userGreeting = username 
      ? `You are chatting with the user: "${username}". Address them politely by name when appropriate (e.g. at the start of a conversation or when summarizing insights), keep track of their project context, and tailor recommendations to their needs.`
      : "";

    const systemPrompt = `You are the "Transcript Studio Brain", an expert AI editor and video content analyst.
You help users review video transcripts, extract insights, draft summaries, generate chapters/timelines, find compelling pull quotes, and write social media copy.

${userGreeting}

Here is the current video context to help you answer:
---
[PROJECT NOTES]
${notes || "(No notes yet)"}
---
[VIDEO TRANSCRIPT]
${transcript || "(No transcript yet)"}
---

INSTRUCTIONS:
1. Provide highly structured, clear, and action-oriented answers.
2. Use markdown formatting (headers, bold, lists, blockquotes, code blocks) to make your response visually compelling.
3. Be direct, concise, and professional. Avoid meta-commentary.
4. Keep the timeline format clear (e.g. "[MM:SS] - Topic Description") if asked to create chapters.
5. If the transcript is empty or the user asks general questions, assist them as best as possible.`;

    const contents = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h.role && h.text) {
          contents.push({
            role: h.role === "assistant" ? "model" : h.role,
            parts: [{ text: h.text }]
          });
        }
      }
    }
    contents.push({
      role: "user",
      parts: [{ text: message }]
    });

    const geminiModel = reqModel || process.env.GEMINI_MODEL || "gemini-2.5-flash";
    console.log(`[Chat] Chat request using model: ${geminiModel}`);

    const keys = getGeminiApiKeys();
    if (keys.length === 0) {
      const auth = await resolveAuth();
      if (!auth) {
        sendJson(res, 500, {
          error: "Authentication failed. Set GEMINI_API_KEY in .env.local or authenticate via: gcloud auth application-default login",
          isAuthMissing: true,
        });
        return;
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent${auth.queryParam}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.headers
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: contents,
          generationConfig: {
            temperature: 0.3,
          }
        })
      });

      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: { message: raw } };
      }

      if (!response.ok) {
        if (data.error?.message?.includes("scope") || data.error?.status === "PERMISSION_DENIED") {
          sendJson(res, 403, {
            error: "Google Cloud authentication scope is insufficient.",
            isScopeError: true,
            diagnosticCommand: "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform",
            message: data.error.message
          });
          return;
        }
        sendJson(res, response.status, {
          error: data.error?.message || data.error || "Gemini API call failed.",
        });
        return;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      sendJson(res, 200, {
        model: geminiModel,
        text: text,
        keyIndex: 0,
      });
      return;
    }

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
      const key = keys[idx];
      console.log(`[Chat] Trying API key index ${idx}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: contents,
            generationConfig: {
              temperature: 0.3,
            }
          })
        });

        const raw = await response.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { error: { message: raw } };
        }

        if (response.ok) {
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          console.log(`[Chat] Success with key index ${idx}`);
          sendJson(res, 200, {
            model: geminiModel,
            text: text,
            keyIndex: idx
          });
          return;
        }

        console.warn(`[Chat] Key index ${idx} failed with status ${response.status}: ${data.error?.message || raw}`);
        lastError = new Error(`Key ${idx} failed (status ${response.status}): ${data.error?.message || raw}`);
      } catch (err) {
        console.warn(`[Chat] Key index ${idx} error:`, err);
        lastError = err;
      }
    }

    sendJson(res, 500, { error: `All API keys failed for chat. Last error: ${lastError ? lastError.message : "Unknown"}` });
  } catch (err) {
    sendJson(res, 500, { error: `Chat brain error: ${err.message}` });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  
  const joinedPath = path.join(root, requested);
  const fullPath = path.normalize(joinedPath);

  if (!fullPath.startsWith(safeRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const contentType = Reflect.has(mimeTypes, ext) ? Reflect.get(mimeTypes, ext) : "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/auth/register") {
    handleRegister(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected registration server error." });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/auth/login") {
    handleLogin(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected login server error." });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/upload-session") {
    handleUploadSession(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected upload session server error." });
    });
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/api/upload-proxy")) {
    handleUploadProxy(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected upload proxy server error." });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/file-status") {
    handleFileStatus(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected file status check server error." });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/transcribe") {
    transcribe(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected transcription server error." });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/transcribe-stream") {
    transcribeStream(req, res).catch((error) => {
      try {
        res.write(`data: ${JSON.stringify({ type: "error", error: error.message })  }\n\n`);
        res.end();
      } catch {}
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    chat(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected chat brain server error." });
    });
    return;
  }
  serveStatic(req, res);
});

loadLocalEnv().then(() => {
  server.listen(port, () => {
    console.log(`Transcript Studio running at http://127.0.0.1:${port}/`);
  });
});
