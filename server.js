const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const model = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize";
const maxUploadBytes = 500 * 1024 * 1024; // Increased to 500 MB to support large video uploads

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function loadLocalEnv() {
  const envPath = path.join(root, ".env.local");
  try {
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // .env.local is optional; environment variables still work.
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

async function transcribe(req, res) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    sendJson(res, 500, {
      error: "GEMINI_API_KEY is not set on the local server. Please write your key in .env.local and restart the server.",
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

  console.log(`[Transcribe] Processing file upload: ${file.name} (size: ${(file.size / 1024 / 1024).toFixed(2)} MB, type: ${mimeType})`);

  let fileUri = null;
  let fileName = null;

  try {
    // 1. Start Resumable Session with Gemini Files API
    console.log(`[Transcribe] Initiating Files API resumable session...`);
    const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiApiKey}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file: {
          display_name: file.name || "video.mp4", // fixed: display_name
        }
      })
    });

    if (!initRes.ok) {
      const errText = await initRes.text();
      throw new Error(`Failed to initiate file upload session: ${errText}`);
    }

    const uploadUrl = initRes.headers.get("x-goog-upload-url") || initRes.headers.get("X-Goog-Upload-URL"); // handles case-insensitive headers safely
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
        "X-Goog-Upload-Command": "upload, finalize", // fixed: upload, finalize
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
    fileName = fileMeta.file?.name; // e.g. "files/abc123xyz"
    if (!fileUri) {
      throw new Error("No file URI received after uploading to Gemini Files API.");
    }

    console.log(`[Transcribe] File uploaded successfully. URI: ${fileUri}, Resource Name: ${fileName}`);

    // 3. Poll file status until it is ACTIVE
    console.log(`[Transcribe] Polling file status to ensure it is fully processed by Google...`);
    let fileState = "PROCESSING";
    const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${geminiApiKey}`;
    
    for (let attempt = 0; attempt < 30; attempt++) {
      const checkRes = await fetch(checkUrl);
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

    const generateRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
    // 5. Cleanup uploaded File to keep AI Studio storage clean
    if (fileName) {
      console.log(`[Transcribe] Cleaning up media resource in background: ${fileName}`);
      fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${geminiApiKey}`, {
        method: "DELETE"
      }).catch((e) => {
        console.error(`[Transcribe] Failed to delete media resource ${fileName}:`, e);
      });
    }
  }
}

async function chat(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    sendJson(res, 500, {
      error: "GEMINI_API_KEY is not set on the local server. Please set GEMINI_API_KEY in .env.local, restart the server, and try again.",
    });
    return;
  }

  const { transcript, notes, message, history } = await parseJson(req);

  const systemPrompt = `You are the "Transcript Studio Brain", an expert AI editor and video content analyst.
You help users review video transcripts, extract insights, draft summaries, generate chapters/timelines, find compelling pull quotes, and write social media copy.

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

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
    sendJson(res, response.status, {
      error: data.error?.message || data.error || "Gemini API call failed.",
    });
    return;
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  sendJson(res, 200, {
    model: geminiModel,
    text: text,
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(root, requested));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/transcribe") {
    transcribe(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message || "Unexpected transcription server error." });
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
