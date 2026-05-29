/**
 * API_BASE — where the Cloudflare Worker lives.
 *
 * LOCAL DEV  → leave as empty string; calls go to the local Node.js server.
 * PRODUCTION → replace the placeholder with your real Worker URL after running:
 *              wrangler deploy
 *
 * Example: "https://transcript-studio.yourname.workers.dev"
 */
const API_BASE =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "" // local Node.js server handles /api/* (relative URL)
    : "https://transcript-studio.penglambot.workers.dev";

const sampleTranscript = `[00:00] Host: Welcome to the launch review. Today we are checking the pacing, key claims, and quotes for the final cut.
[00:08] Guest: The biggest shift is that viewers want useful clips faster, but they still expect accuracy and context.
[00:17] Host: That is exactly why the transcript matters. It becomes the map for edits, captions, and follow-up notes.
[00:27] Guest: I would mark this answer as a pull quote because it explains the product in one clean sentence.
[00:37] Host: Great. We will export this as text first, then send a subtitle file to the editing team.`;

const state = {
  cues: [],
  activeIndex: -1,
  videoFile: null,
  uploadFile: null,  // audio-extracted version of videoFile (much smaller)
  isTranscribing: false,
  lastFinalTranscript: "",
  chatHistory: [],
  isThinking: false,
  activeProjectId: null,
  projects: [],
  geminiModel: "gemini-3.5-flash",
  activeChatKeyIndex: 0,
  currentUser: null,
  authMode: "login",
};

const els = {
  video: document.querySelector("#video"),
  videoInput: document.querySelector("#videoInput"),
  transcriptInput: document.querySelector("#transcriptInput"),
  rawTranscript: document.querySelector("#rawTranscript"),
  cueList: document.querySelector("#cueList"),
  emptyState: document.querySelector("#emptyState"),
  searchInput: document.querySelector("#searchInput"),
  reviewTab: document.querySelector("#reviewTab"),
  editTab: document.querySelector("#editTab"),
  brainTab: document.querySelector("#brainTab"),
  reviewView: document.querySelector("#reviewView"),
  editView: document.querySelector("#editView"),
  brainView: document.querySelector("#brainView"),
  saveTranscript: document.querySelector("#saveTranscript"),
  formatTranscript: document.querySelector("#formatTranscript"),
  loadSample: document.querySelector("#loadSample"),
  emptySample: document.querySelector("#emptySample"),
  exportTxt: document.querySelector("#exportTxt"),
  startTranscription: document.querySelector("#startTranscription"),
  recordingStatus: document.querySelector("#recordingStatus"),
  themeToggle: document.querySelector("#themeToggle"),
  projectTitle: document.querySelector("#projectTitle"),
  speakerName: document.querySelector("#speakerName"),
  speakerMode: document.querySelector("#speakerMode"),
  transcriptLanguage: document.querySelector("#transcriptLanguage"),
  geminiModel: document.querySelector("#geminiModel"),
  notes: document.querySelector("#notes"),
  cueCount: document.querySelector("#cueCount"),
  wordCount: document.querySelector("#wordCount"),
  durationText: document.querySelector("#durationText"),
  brainMessages: document.querySelector("#brainMessages"),
  brainChatEmpty: document.querySelector("#brainChatEmpty"),
  brainTyping: document.querySelector("#brainTyping"),
  brainForm: document.querySelector("#brainForm"),
  brainInput: document.querySelector("#brainInput"),
  brainSend: document.querySelector("#brainSend"),
  brainSummBtn: document.querySelector("#brainSummBtn"),
  brainChaptBtn: document.querySelector("#brainChaptBtn"),
  brainQuoteBtn: document.querySelector("#brainQuoteBtn"),
  brainSocialBtn: document.querySelector("#brainSocialBtn"),
  projectCount: document.querySelector("#projectCount"),
  historyList: document.querySelector("#historyList"),
  newProjectBtn: document.querySelector("#newProjectBtn"),
  // Auth Elements
  loginWall: document.querySelector("#loginWall"),
  appShell: document.querySelector("#appShell"),
  tabSignIn: document.querySelector("#tabSignIn"),
  tabSignUp: document.querySelector("#tabSignUp"),
  authForm: document.querySelector("#authForm"),
  authUsername: document.querySelector("#authUsername"),
  authPassword: document.querySelector("#authPassword"),
  authError: document.querySelector("#authError"),
  authSubmitBtn: document.querySelector("#authSubmitBtn"),
  authSubtitle: document.querySelector("#authSubtitle"),
  userGreeting: document.querySelector("#userGreeting"),
  userAvatar: document.querySelector("#userAvatar"),
  userName: document.querySelector("#userName"),
  signOutBtn: document.querySelector("#signOutBtn"),
  diagnosticModal: null,
  diagnosticIntro: null,
  diagnosticErrorDesc: null,
  diagnosticCode: null,
  copyDiagnosticCodeBtn: null,
  closeDiagnosticBtn: null,
};

/* ==========================================================================
   Audio Extraction — strip video to tiny 16 kHz mono WAV before upload
   ========================================================================== */

/** Encode Float32 PCM samples into a WAV ArrayBuffer (no dependencies). */
function encodePcmToWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return buf;
}

/**
 * Extract just the audio track from a video file and return a compact
 * 16 kHz mono WAV File. Falls back to the original on any failure.
 * A 500 MB video typically becomes a 20 MB WAV — 25× smaller.
 */
async function extractAudioTrack(file) {
  const isVideo = file.type.startsWith("video/") ||
    /\.(mp4|mov|avi|mkv|wmv|flv|m4v|3gp|ts|mts)$/i.test(file.name);
  // Skip if already an audio file, or too large to safely decode in-browser
  if (!isVideo || file.size > 600 * 1024 * 1024) return file;

  try {
    setRecordingStatus("⚡ Extracting audio from video for instant upload...", "live");
    const arrayBuffer = await file.arrayBuffer();

    // Decode the media's audio codec using the browser's native decoder
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    let decoded;
    try {
      decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      tempCtx.close().catch(() => {});
    }

    // Re-render at exactly 16 kHz mono (optimal for speech AI — Whisper uses the same)
    const offCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = offCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(offCtx.destination);
    src.start(0);
    const rendered = await offCtx.startRendering();

    const wavBuf = encodePcmToWav(rendered.getChannelData(0), 16000);
    const wavFile = new File(
      [wavBuf],
      file.name.replace(/\.[^.]+$/, ".wav"),
      { type: "audio/wav" }
    );

    const pct = ((1 - wavFile.size / file.size) * 100).toFixed(0);
    console.log(`[AudioExtract] ${(file.size / 1e6).toFixed(1)} MB → ${(wavFile.size / 1e6).toFixed(1)} MB (${pct}% smaller)`);
    setRecordingStatus(`⚡ Audio extracted: ${(file.size / 1e6).toFixed(0)} MB → ${(wavFile.size / 1e6).toFixed(0)} MB (${pct}% smaller). Ready to upload!`);
    return wavFile;
  } catch (e) {
    console.warn("[AudioExtract] Could not extract audio, using original file:", e);
    return file;
  }
}

/* ==========================================================================
   SSE Reader — parse a streaming fetch response as Server-Sent Events
   ========================================================================== */

/**
 * Async generator that yields parsed JSON objects from a fetch() SSE response.
 * Usage: for await (const event of readSSE(response)) { ... }
 */
async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try { yield JSON.parse(line.slice(6)); } catch {}
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ========================================================================== */

function parseTime(value) {
  const clean = value.replace(",", ".").trim();
  const parts = clean.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatTime(seconds = 0) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function parseTranscript(text) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+$/.test(line) && !/^WEBVTT/i.test(line));

  const cues = [];
  let pendingTime = null;

  for (const line of lines) {
    const rangeMatch = line.match(/^(\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*((\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/);
    if (rangeMatch) {
      pendingTime = parseTime(line.split("-->")[0]);
      continue;
    }

    const bracketMatch = line.match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*(.*)$/);
    let start = pendingTime;
    let body = line;
    if (bracketMatch) {
      start = parseTime(bracketMatch[1]);
      body = bracketMatch[2].trim();
    }

    if (start === null) {
      start = cues.length ? cues.at(-1).start + 8 : 0;
    }

    const speakerMatch = body.match(/^([^:]{1,32}):\s*(.*)$/);
    const speaker = speakerMatch ? speakerMatch[1].trim() : els.speakerName.value.trim() || "Speaker";
    const textValue = speakerMatch ? speakerMatch[2].trim() : body;

    if (textValue) {
      cues.push({ start, speaker, text: textValue });
    }
    pendingTime = null;
  }

  return cues.sort((a, b) => a.start - b.start);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#039;";
      default: return char;
    }
  });
}

function renderHighlightedText(container, text, query) {
  container.textContent = "";
  if (!query) {
    container.textContent = text;
    return;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIndex = 0;
  let index = lowerText.indexOf(lowerQuery);

  while (index !== -1) {
    if (index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, index)));
    }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + query.length);
    container.appendChild(mark);
    lastIndex = index + query.length;
    index = lowerText.indexOf(lowerQuery, lastIndex);
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function appendHtmlSafely(container, htmlString) {
  container.textContent = "";
  if (!htmlString) return;
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const fragment = document.createDocumentFragment();
  while (doc.body.firstChild) {
    fragment.appendChild(doc.body.firstChild);
  }
  container.appendChild(fragment);
}

function renderCues() {
  const query = els.searchInput.value.trim();
  const visible = state.cues.filter((cue) => {
    const haystack = `${cue.speaker} ${cue.text}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  els.emptyState.classList.toggle("hidden", state.cues.length > 0);

  els.cueList.textContent = "";
  const fragment = document.createDocumentFragment();

  visible.forEach((cue) => {
    const index = state.cues.indexOf(cue);
    const active = index === state.activeIndex;

    const button = document.createElement("button");
    button.type = "button";
    button.className = active ? "cue active" : "cue";
    button.setAttribute("data-index", String(index));

    const timeSpan = document.createElement("span");
    timeSpan.className = "cue-time";
    timeSpan.textContent = formatTime(cue.start);
    button.appendChild(timeSpan);

    const p = document.createElement("p");

    const speakerSpan = document.createElement("span");
    speakerSpan.className = "cue-speaker";
    renderHighlightedText(speakerSpan, cue.speaker, query);
    p.appendChild(speakerSpan);

    p.appendChild(document.createTextNode(": "));

    const textSpan = document.createElement("span");
    renderHighlightedText(textSpan, cue.text, query);
    p.appendChild(textSpan);

    button.appendChild(p);
    fragment.appendChild(button);
  });

  els.cueList.appendChild(fragment);

  updateStats();
}

function updateStats() {
  const words = state.cues.reduce((sum, cue) => sum + cue.text.split(/\s+/).filter(Boolean).length, 0);
  const duration = els.video.duration || (state.cues.length ? state.cues.at(-1).start : 0);
  els.cueCount.textContent = String(state.cues.length);
  els.wordCount.textContent = String(words);
  els.durationText.textContent = formatTime(duration);
}

function setRecordingStatus(message, type = "") {
  els.recordingStatus.textContent = message;
  els.recordingStatus.classList.toggle("live", type === "live");
  els.recordingStatus.classList.toggle("error", type === "error");
}

function updateStartButton() {
  els.startTranscription.classList.toggle("recording", state.isTranscribing);
  els.startTranscription.innerHTML = state.isTranscribing
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg>Working`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7-11-7Z" /></svg>Start`;
  els.startTranscription.disabled = state.isTranscribing;
}

function appendTranscriptCue(text, start = els.video.currentTime || 0) {
  const clean = text.trim();
  if (!clean || clean === state.lastFinalTranscript) return;
  state.lastFinalTranscript = clean;
  state.cues.push({
    start,
    speaker: els.speakerName.value.trim() || "Speaker",
    text: clean,
  });
  els.rawTranscript.value = serializeTranscript();
  renderCues();
  persist();
}

function setTab(tab) {
  els.reviewView.classList.toggle("hidden", tab !== "review");
  els.editView.classList.toggle("hidden", tab !== "edit");
  els.brainView.classList.toggle("hidden", tab !== "brain");

  els.reviewTab.classList.toggle("active", tab === "review");
  els.editTab.classList.toggle("active", tab === "edit");
  els.brainTab.classList.toggle("active", tab === "brain");
  
  if (tab === "brain") {
    scrollChatToBottom();
  }
}

function loadTranscript(text) {
  els.rawTranscript.value = text;
  state.cues = parseTranscript(text);
  state.activeIndex = -1;
  renderCues();
  persist();
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
    speaker: els.speakerName.value.trim() || "Speaker",
    text: chunk,
  }));
}

async function startAutoTranscription(startKeyIndex = 0, retryAttempt = 0) {
  if (!state.videoFile) {
    setRecordingStatus("Add a video first, then press Start.", "error");
    return;
  }

  state.isTranscribing = true;
  state.lastFinalTranscript = "";
  updateStartButton();
  setTab("review");

  // Use the audio-extracted file if available (much smaller than raw video)
  const uploadFile = state.uploadFile || state.videoFile;
  const mimeType = uploadFile.type || "audio/wav";
  const language = els.transcriptLanguage.value.split("-")[0] || "my";

  // Define our active working models — fastest/healthiest first
  const models = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
  const userSelectedModel = els.geminiModel.value || "gemini-3.5-flash";
  const modelRotation = [
    userSelectedModel,
    ...models.filter((m) => m !== userSelectedModel)
  ];
  const currentModel = modelRotation.at(retryAttempt % modelRotation.length);

  let isRetrying = false;
  let sessionData = null;

  try {
    els.video.play().catch(() => {});

    // ── Step 1: Start a Google resumable upload session ──────────────────────
    setRecordingStatus(`Connecting to transcription service [${currentModel}]...`, "live");
    const sessionRes = await fetch(`${API_BASE}/api/upload-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: uploadFile.name || "media",
        fileSize: uploadFile.size,
        mimeType,
        startKeyIndex,
      }),
    });
    sessionData = await sessionRes.json();
    if (!sessionRes.ok || sessionData.error) {
      throw new Error(sessionData.error || "Could not start upload session.");
    }

    // Guard: reject files over 1 GB (post-extraction they should never hit this)
    if (uploadFile.size > 1073741824) {
      throw new Error("File size exceeds 1 GB limit. Please split the media into smaller parts.");
    }

    setRecordingStatus("Uploading media: 0%...", "live");

    // ── Step 2: Upload in 64 MB chunks directly to Google ────────────────────
    const CHUNK_SIZE = 64 * 1024 * 1024; // 64 MB (128× more than the old 512 KB)
    const uploadUrl = sessionData.uploadUrl;
    const file = uploadFile;
    const totalSize = file.size;
    let offset = 0;
    let fileMeta;
    let useProxy = true;

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunk = file.slice(offset, end);
      const isLast = end >= totalSize;
      const command = isLast ? "upload, finalize" : "upload";

      const pct = Math.round((end / totalSize) * 100);
      setRecordingStatus(
        pct < 100
          ? `Uploading media: ${pct}%...`
          : "Upload done — Google is activating your media...",
        "live"
      );

      let chunkRes;
      let retries = 4;
      let lastError;

      while (retries > 0) {
        try {
          console.log(`Chunk offset=${offset} size=${chunk.size} command=${command} proxy=${useProxy}`);

          if (!useProxy) {
            chunkRes = await fetch(uploadUrl, {
              method: "POST",
              headers: {
                "X-Goog-Upload-Offset": String(offset),
                "X-Goog-Upload-Command": command,
                "Content-Type": file.type || "application/octet-stream",
              },
              body: chunk,
            });
          } else {
            const proxyUrl = `${API_BASE}/api/upload-proxy?uploadUrl=${encodeURIComponent(uploadUrl)}`;
            chunkRes = await fetch(proxyUrl, {
              method: "POST",
              headers: {
                "X-Goog-Upload-Offset": String(offset),
                "X-Goog-Upload-Command": command,
                "X-Goog-Upload-Protocol": "resumable",
                "Content-Type": file.type || "application/octet-stream",
                "X-Goog-Upload-Content-Type": file.type || "application/octet-stream",
              },
              body: chunk,
            });
          }

          console.log(`Upload response: ${chunkRes.status}`);
          if (chunkRes.status === 200 || chunkRes.status === 201 || chunkRes.status === 308) {
            break;
          }

          let errText = "";
          try { errText = await chunkRes.text(); } catch {}
          let errData;
          try { errData = JSON.parse(errText); } catch { errData = { error: errText }; }
          lastError = new Error(errData.error || `Server returned status ${chunkRes.status}`);
        } catch (e) {
          if (!useProxy && (e instanceof TypeError || String(e).includes("CORS") || String(e).includes("Failed to fetch"))) {
            console.warn("Direct upload blocked by CORS, switching to proxy.", e);
            useProxy = true;
            lastError = e;
            continue;
          }
          lastError = e;
        }

        retries--;
        if (retries > 0) {
          const delay = Math.pow(2, 4 - retries) * 1000;
          console.warn(`Chunk failed, retrying in ${delay / 1000}s (${retries} left)`, lastError);
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      if (!chunkRes || (chunkRes.status !== 200 && chunkRes.status !== 201 && chunkRes.status !== 308)) {
        throw new Error(lastError?.message || `Upload failed at offset ${offset}`);
      }

      if (isLast) {
        try { fileMeta = await chunkRes.json(); }
        catch { throw new Error("Failed to parse Google response on upload finalization."); }
      }

      offset = end;
    }

    const fileUri  = fileMeta?.file?.uri;
    const fileName = fileMeta?.file?.name;
    if (!fileUri || !fileName) {
      throw new Error("No file URI returned after upload.");
    }

    // ── Steps 2.5 + 3 combined: server-side activation + streaming transcription ──
    // The server polls Google's Files API every 500ms internally (no browser round-trips)
    // and fires streamGenerateContent the instant the file flips to ACTIVE.
    // Live counter ticks arrive via SSE so the UI stays responsive.
    setRecordingStatus("⏳ Google activating media...", "live");
    const speakerMode = els.speakerMode.value;
    const txRes = await fetch(`${API_BASE}/api/transcribe-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileUri,
        fileName,
        language,
        mimeType,
        speakerMode,
        geminiModel: currentModel,
        keyIndex: sessionData.keyIndex || 0,
      }),
    });

    if (!txRes.ok) {
      const errData = await txRes.json().catch(() => ({}));
      throw new Error(errData.error || "Transcription stream failed to start.");
    }

    let rawStreamText = "";
    for await (const event of readSSE(txRes)) {
      if (event.type === "activating") {
        // Live counter ticks from server-side polling
        const suffix = event.ready ? " — starting transcription..." : "";
        setRecordingStatus(`⏳ Google activating... ${event.elapsed}s${suffix}`, "live");
      } else if (event.type === "chunk") {
        rawStreamText += event.text;
        // Parse and show partial cues in real time as text streams in
        const partialCues = parseTranscript(rawStreamText);
        if (partialCues.length > 0) {
          state.cues = partialCues;
          els.rawTranscript.value = rawStreamText;
          renderCues();
          setRecordingStatus(`🔄 Transcribing... ${state.cues.length} segments so far`, "live");
        }
      } else if (event.type === "done") {
        state.cues = normalizeAiCues(event.cues, event.text);
        els.rawTranscript.value = serializeTranscript();
        renderCues();
        persist();
        setRecordingStatus("✅ AI transcript ready! Review, edit, or export it.");
        break;
      } else if (event.type === "error") {
        throw new Error(event.error || "Streaming transcription error.");
      }
    }
  } catch (error) {
    console.error("Transcription error:", error);
    const errText = String(error.message || "");
    const isValidationErr = errText.includes("File size exceeds") || errText.includes("Add a video first");

    const NUM_KEYS = 3;
    const MAX_RETRIES = NUM_KEYS * 3; // 3 keys × 3 models = 9 phases total

    if (!isValidationErr && retryAttempt < MAX_RETRIES) {
      isRetrying = true;

      // Extract a clean, brief error message to display
      let displayErr = errText.replace("Error: ", "");
      if (displayErr.length > 50) {
        displayErr = displayErr.substring(0, 47) + "...";
      }

      // Automatically determine the next key index and model to try
      const nextKeyIndex = (startKeyIndex + 1) % NUM_KEYS;
      const nextModel = modelRotation.at((retryAttempt + 1) % modelRotation.length);

      setRecordingStatus(`⚠️ Retry ${retryAttempt + 1}/${MAX_RETRIES}: ${displayErr} — trying key ${nextKeyIndex + 1} with ${nextModel}...`, "live");
      await new Promise((r) => setTimeout(r, 3000));
      return startAutoTranscription(nextKeyIndex, retryAttempt + 1);
    }

    // All 9 retries exhausted
    setRecordingStatus(`❌ Transcription failed after 9 automated retries across all keys/models. Last error: ${error.message}`, "error");
  } finally {
    if (!isRetrying) {
      state.isTranscribing = false;
      updateStartButton();
    }
  }
}

function serializeTranscript() {
  return state.cues.map((cue) => `[${formatTime(cue.start)}] ${cue.speaker}: ${cue.text}`).join("\n");
}

function normalizeAiCues(cues = [], text = "") {
  if (Array.isArray(cues) && cues.length) {
    return cues.map((cue, index) => ({
      start: Number(cue.start) || index * 8,
      speaker: cue.speaker || els.speakerName.value.trim() || "Speaker",
      text: cue.text || "",
    })).filter((cue) => cue.text.trim());
  }
  return parseTranscript(text || "");
}

function download(filename, contents, type = "text/plain") {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function persist() {
  if (!state.currentUser) return;

  if (!state.activeProjectId) {
    state.activeProjectId = Date.now();
  }

  let project = state.projects.find((p) => p.id === state.activeProjectId);
  if (!project) {
    project = { id: state.activeProjectId };
    state.projects.push(project);
  }

  project.title = els.projectTitle.value.trim() || "Untitled interview";
  project.speaker = els.speakerName.value.trim() || "Speaker 1";
  project.speakerMode = els.speakerMode.value || "auto";
  project.notes = els.notes.value.trim();
  project.transcript = els.rawTranscript.value;
  project.language = els.transcriptLanguage.value;
  project.geminiModel = els.geminiModel.value || "gemini-3.5-flash";
  project.chatHistory = state.chatHistory || [];
  project.updatedAt = Date.now();

  // Enforce limit of 40 projects
  state.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  while (state.projects.length > 40) {
    state.projects.pop();
  }

  localStorage.setItem(`transcript-studio-projects-${state.currentUser}`, JSON.stringify(state.projects));
  localStorage.setItem(`transcript-studio-active-id-${state.currentUser}`, String(state.activeProjectId));
  localStorage.setItem("transcript-studio-theme", document.documentElement.dataset.theme || "light");

  renderHistoryList();
}

function restore() {
  if (!state.currentUser) return;

  const savedTheme = localStorage.getItem("transcript-studio-theme");
  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme;
  }

  const rawProjects = localStorage.getItem(`transcript-studio-projects-${state.currentUser}`);
  const savedActiveId = localStorage.getItem(`transcript-studio-active-id-${state.currentUser}`);

  try {
    state.projects = rawProjects ? JSON.parse(rawProjects) : [];
  } catch {
    state.projects = [];
  }

  if (state.projects.length === 0) {
    state.activeProjectId = Date.now();
    state.projects = [{
      id: state.activeProjectId,
      title: "Untitled interview",
      speaker: state.currentUser,
      notes: "",
      transcript: "",
      language: "my-MM",
      geminiModel: "gemini-2.5-flash",
      chatHistory: [],
      updatedAt: Date.now()
    }];
  } else {
    state.activeProjectId = Number(savedActiveId) || state.projects[0].id;
    if (!state.projects.some(p => p.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0].id;
    }
  }

  loadActiveProject();
}

els.videoInput.addEventListener("change", () => {
  const [file] = els.videoInput.files;
  if (!file) return;

  // Reset state
  state.videoFile = null;
  state.uploadFile = null;
  els.rawTranscript.value = "";

  state.videoFile = file;
  els.video.src = URL.createObjectURL(file);
  els.video.load();
  els.projectTitle.value = file.name.replace(/\.[^.]+$/, "");
  persist();

  // Auto-extract audio from video files in the background
  // This makes the eventual upload 10-25× smaller and much faster
  extractAudioTrack(file).then(extracted => {
    state.uploadFile = extracted;
    if (extracted !== file) {
      console.log(`[AutoExtract] Upload file ready: ${extracted.name} (${(extracted.size / 1e6).toFixed(1)} MB)`);
    }
  }).catch(() => { state.uploadFile = file; });
});

els.transcriptInput.addEventListener("change", async () => {
  const [file] = els.transcriptInput.files;
  if (!file) return;
  loadTranscript(await file.text());
});

els.cueList.addEventListener("click", (event) => {
  const cueButton = event.target.closest(".cue");
  if (!cueButton) return;
  const index = Number(cueButton.dataset.index);
  const cue = state.cues[index];
  if (!cue) return;
  state.activeIndex = index;
  if (els.video.src) {
    els.video.currentTime = cue.start;
    els.video.play().catch(() => {});
  }
  renderCues();
});

els.video.addEventListener("timeupdate", () => {
  const index = state.cues.findLastIndex((cue) => cue.start <= els.video.currentTime + 0.3);
  if (index !== state.activeIndex) {
    state.activeIndex = index;
    renderCues();
  }
});

els.video.addEventListener("loadedmetadata", updateStats);
els.video.addEventListener("error", () => {
  if (!els.video.src || els.video.src === window.location.href || !els.video.currentSrc) {
    return;
  }
  const error = els.video.error;
  const messages = {
    1: "Video loading was cancelled. Choose the video file again.",
    2: "The browser could not load this video from disk. Choose it again, or try MP4/M4A/WAV audio.",
    3: "The browser could not decode this video format. Try MP4, M4A, MP3, or WAV.",
    4: "This video format is not supported by the browser. Try MP4, M4A, MP3, or WAV.",
  };
  const errCode = error?.code;
  const errMsg = Object.prototype.hasOwnProperty.call(messages, errCode) ? messages[errCode] : undefined;
  setRecordingStatus(errMsg || "Unable to load the video file. Choose it again, or try MP4/M4A/WAV.", "error");
});
/* ==========================================================================
   AI Brain Workspace Core Logic
   ========================================================================= */

function parseMarkdown(text) {
  let html = text
    .replace(/[&<>"']/g, (char) => {
      switch (char) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#039;";
        default: return char;
      }
    });

  // Code blocks: ```javascript\n...\n```
  html = html.replace(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/g, '<pre><code>$1</code></pre>');

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers: ### Header
  html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

  // Blockquotes: > Text
  html = html.replace(/^&gt; (.*?)$/gm, '<blockquote>$1</blockquote>');

  // Bullet Lists: - Item or * Item
  html = html.replace(/^\s*[-*] (.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>');

  // Ordered Lists: 1. Item
  html = html.replace(/^\s*\d+\.\s*(.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>'); 

  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Paragraphs (lines separated by double newlines)
  html = html.replace(/\n\n/g, '</p><p>');

  // Simple line breaks
  html = html.replace(/\n/g, '<br>');

  if (!html.startsWith('<p>') && !html.startsWith('<h3>') && !html.startsWith('<h2>') && !html.startsWith('<h1>') && !html.startsWith('<pre>')) {
    html = '<p>' + html + '</p>';
  }

  return html.replace(/<p><\/p>/g, '');
}

function renderChatMessages() {
  const empty = state.chatHistory.length === 0;
  els.brainChatEmpty.classList.toggle("hidden", !empty);
  els.brainMessages.classList.toggle("hidden", empty);

  if (empty) {
    els.brainMessages.textContent = "";
    return;
  }

  const html = state.chatHistory
    .map((msg, index) => {
      const isUser = msg.role === "user";
      const alignmentClass = isUser ? "user" : "assistant";
      
      let actionsHtml = "";
      if (!isUser) {
        actionsHtml = `
          <div class="brain-msg-actions">
            <button class="msg-action-btn" id="btn-copy-${index}" onclick="copyMessageText(${index})" type="button">
              <span>📋</span> Copy
            </button>
            <button class="msg-action-btn" id="btn-apply-${index}" onclick="applyMessageToNotes(${index})" type="button">
              <span>📝</span> Apply to Notes
            </button>
          </div>
        `;
      }

      const contentHtml = isUser ? escapeHtml(msg.text) : parseMarkdown(msg.text);

      return `
        <div class="brain-msg ${alignmentClass}">
          ${contentHtml}
          ${actionsHtml}
        </div>
      `;
    })
    .join("");

  appendHtmlSafely(els.brainMessages, html);
}

function scrollChatToBottom() {
  const container = document.querySelector(".brain-chat-container");
  if (container) {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth"
    });
  }
}

async function sendMessageToBrain(messageText) {
  if (!messageText.trim() || state.isThinking) return;

  // Clear input
  els.brainInput.value = "";
  els.brainInput.style.height = "auto";

  // Hide empty state, show messages
  els.brainChatEmpty.classList.add("hidden");
  els.brainMessages.classList.remove("hidden");

  // Push user message
  state.chatHistory.push({ role: "user", text: messageText });
  renderChatMessages();
  persist();

  // Show typing indicator
  els.brainTyping.classList.remove("hidden");
  state.isThinking = true;
  els.brainSend.disabled = true;
  els.brainInput.disabled = true;

  scrollChatToBottom();

  try {
    // POST to the CF Worker proxy — the API key never touches the browser.
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: els.rawTranscript.value || "",
        notes: els.notes.value || "",
        message: messageText,
        history: state.chatHistory.slice(0, -1),
        username: state.currentUser,
        geminiModel: els.geminiModel.value || "gemini-2.5-flash",
        keyIndex: state.activeChatKeyIndex || 0,
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      if (data.isScopeError || data.isAuthMissing) {
        showDiagnostic(data);
      }
      throw new Error(data.error || "AI Brain request failed.");
    }

    if (data.keyIndex !== undefined) {
      state.activeChatKeyIndex = data.keyIndex;
    }

    state.chatHistory.push({ role: "assistant", text: data.text || "" });
    renderChatMessages();
    persist();
  } catch (error) {
    state.chatHistory.push({ role: "assistant", text: `❌ **Error**: ${error.message}` });
    renderChatMessages();
  } finally {
    els.brainTyping.classList.add("hidden");
    state.isThinking = false;
    els.brainSend.disabled = false;
    els.brainInput.disabled = false;
    els.brainInput.focus();
    scrollChatToBottom();
  }
}

window.copyMessageText = (index) => {
  const msg = state.chatHistory.at(index);
  if (!msg) return;
  navigator.clipboard.writeText(msg.text).then(() => {
    const btn = document.querySelector(`#btn-copy-${index}`);
    if (btn) {
      const orig = btn.innerHTML;
      btn.textContent = "Copied! ✓";
      btn.style.color = "var(--accent-strong)";
      setTimeout(() => {
        appendHtmlSafely(btn, orig);
        btn.style.color = "";
      }, 1200);
    }
  });
};

window.applyMessageToNotes = (index) => {
  const msg = state.chatHistory.at(index);
  if (!msg) return;
  const currentNotes = els.notes.value.trim();
  const title = `### Brain Insights (${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})})`;
  els.notes.value = currentNotes 
    ? `${currentNotes}\n\n${title}\n${msg.text}`
    : `${title}\n${msg.text}`;
  
  els.notes.focus();
  persist();

  const btn = document.querySelector(`#btn-apply-${index}`);
  if (btn) {
    const orig = btn.innerHTML;
    btn.textContent = "Applied! ✓";
    btn.style.color = "var(--accent-strong)";
    setTimeout(() => {
      appendHtmlSafely(btn, orig);
      btn.style.color = "";
    }, 1200);
  }
};

els.searchInput.addEventListener("input", renderCues);
els.reviewTab.addEventListener("click", () => setTab("review"));
els.editTab.addEventListener("click", () => setTab("edit"));
els.brainTab.addEventListener("click", () => setTab("brain"));

els.brainForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessageToBrain(els.brainInput.value);
});

els.brainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.brainForm.requestSubmit();
  }
});

els.brainInput.addEventListener("input", () => {
  els.brainInput.style.height = "auto";
  els.brainInput.style.height = els.brainInput.scrollHeight + "px";
});

els.brainSummBtn.addEventListener("click", () => sendMessageToBrain("Summarize this transcript and list the key takeaways."));
els.brainChaptBtn.addEventListener("click", () => sendMessageToBrain("Generate a timestamped outline (chapters) of the topics discussed in this transcript."));
els.brainQuoteBtn.addEventListener("click", () => sendMessageToBrain("Identify and extract the 3-5 most compelling pull quotes from the transcript, with timestamps and speaker names."));
els.brainSocialBtn.addEventListener("click", () => sendMessageToBrain("Write a dynamic LinkedIn post draft and 3 Twitter/X post drafts summarizing this video content."));
els.saveTranscript.addEventListener("click", () => {
  loadTranscript(els.rawTranscript.value);
  setTab("review");
});
els.formatTranscript.addEventListener("click", () => {
  state.cues = parseTranscript(els.rawTranscript.value);
  els.rawTranscript.value = serializeTranscript();
  renderCues();
  persist();
});
els.loadSample.addEventListener("click", () => loadTranscript(sampleTranscript));
els.emptySample.addEventListener("click", () => loadTranscript(sampleTranscript));
els.startTranscription.addEventListener("click", () => {
  startAutoTranscription();
});
els.exportTxt.addEventListener("click", () => {
  const title = els.projectTitle.value.trim() || "transcript";
  const notes = els.notes.value.trim();
  const body = `${title}\n\n${serializeTranscript()}${notes ? `\n\nNotes\n${notes}` : ""}\n`;
  download(`${title.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.txt`, body);
});
els.themeToggle.addEventListener("click", () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  persist();
});
/* ==========================================================================
   Project Management History Logic
   ========================================================================== */

function loadActiveProject() {
  const project = state.projects.find((p) => p.id === state.activeProjectId) || state.projects[0];
  if (!project) return;

  state.activeProjectId = project.id;
  
  els.projectTitle.value = project.title || "Untitled interview";
  els.speakerName.value = project.speaker || "Speaker 1";
  els.speakerMode.value = project.speakerMode || "auto";
  els.notes.value = project.notes || "";
  els.transcriptLanguage.value = project.language || "my-MM";
  els.geminiModel.value = project.geminiModel || "gemini-3.5-flash";
  els.rawTranscript.value = project.transcript || "";
  
  state.cues = parseTranscript(project.transcript || "");
  state.activeIndex = -1;
  renderCues();

  state.chatHistory = project.chatHistory || [];
  renderChatMessages();

  renderHistoryList();
}

function renderHistoryList() {
  const count = state.projects.length;
  els.projectCount.textContent = `${count}/40`;

  if (count === 0) {
    appendHtmlSafely(els.historyList, `<div style="text-align: center; color: var(--muted); font-size: 12px; padding: 12px;">No saved projects</div>`);
    return;
  }

  const html = state.projects
    .map((project) => {
      const activeClass = project.id === state.activeProjectId ? " active" : "";
      const date = new Date(project.updatedAt);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });

      return `
        <div class="history-item${activeClass}" onclick="selectProject(${project.id})" role="button">
          <div class="history-item-info">
            <span class="history-item-title">${escapeHtml(project.title)}</span>
            <div class="history-item-meta">
              <span>👤 ${escapeHtml(project.speaker)}</span>
              <span>🕒 ${dateStr}, ${timeStr}</span>
            </div>
          </div>
          <button class="history-item-delete" onclick="deleteProject(event, ${project.id})" title="Delete project" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>
            </svg>
          </button>
        </div>
      `;
    })
    .join("");

  appendHtmlSafely(els.historyList, html);
}

window.selectProject = (projectId) => {
  state.activeProjectId = projectId;
  if (els.video.src) {
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.load();
  }
  loadActiveProject();
};

window.deleteProject = (event, projectId) => {
  event.stopPropagation();
  if (!confirm("Are you sure you want to delete this project?")) return;

  const index = state.projects.findIndex((p) => p.id === projectId);
  if (index === -1) return;

  state.projects.splice(index, 1);

  if (state.activeProjectId === projectId) {
    if (state.projects.length > 0) {
      state.activeProjectId = state.projects[0].id;
    } else {
      state.activeProjectId = Date.now();
      state.projects.push({
        id: state.activeProjectId,
        title: "Untitled interview",
        speaker: "Speaker 1",
        notes: "",
        transcript: "",
        language: "my-MM",
        chatHistory: [],
        updatedAt: Date.now()
      });
    }
  }

  localStorage.setItem("transcript-studio-projects", JSON.stringify(state.projects));
  localStorage.setItem("transcript-studio-active-id", String(state.activeProjectId));
  
  loadActiveProject();
};

function createNewProject() {
  state.activeProjectId = Date.now();
  state.projects.unshift({
    id: state.activeProjectId,
    title: "Untitled interview",
    speaker: "Speaker 1",
    notes: "",
    transcript: "",
    language: "my-MM",
    chatHistory: [],
    updatedAt: Date.now()
  });

  while (state.projects.length > 40) {
    state.projects.pop();
  }

  if (els.video.src) {
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.load();
  }
  
  loadActiveProject();
  persist();

  els.projectTitle.focus();
  els.projectTitle.select();
}

[els.projectTitle, els.speakerName, els.speakerMode, els.transcriptLanguage, els.geminiModel, els.notes, els.rawTranscript].forEach((el) => {
  if (el) {
    el.addEventListener("input", persist);
    el.addEventListener("change", persist);
  }
});

els.newProjectBtn.addEventListener("click", createNewProject);

// ─── Authentication Event Handlers & Core Functions ─────────────────────────

function setAuthMode(mode) {
  state.authMode = mode;
  els.authError.classList.add("hidden");
  els.authError.textContent = "";
  els.authUsername.value = "";
  els.authPassword.value = "";

  if (mode === "login") {
    els.tabSignIn.classList.add("active");
    els.tabSignUp.classList.remove("active");
    els.tabSignIn.setAttribute("aria-selected", "true");
    els.tabSignUp.setAttribute("aria-selected", "false");
    els.authSubtitle.textContent = "Sign in to open your workspace";
    els.authSubmitBtn.textContent = "Sign In";
  } else {
    els.tabSignIn.classList.remove("active");
    els.tabSignUp.classList.add("active");
    els.tabSignIn.setAttribute("aria-selected", "false");
    els.tabSignUp.setAttribute("aria-selected", "true");
    els.authSubtitle.textContent = "Create an account to start reviewing";
    els.authSubmitBtn.textContent = "Create Account";
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;

  if (!username || !password) return;

  els.authSubmitBtn.disabled = true;
  els.authSubmitBtn.textContent = state.authMode === "login" ? "Signing In..." : "Creating...";
  els.authError.classList.add("hidden");

  // On the live Cloudflare Worker, auth endpoints live on the Worker (API_BASE).
  // On local dev (localhost), they live on the local Node.js server (relative URL).
  const authBase = isLiveWorker ? API_BASE : "";
  const endpoint = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";

  try {
    const response = await fetch(`${authBase}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "Authentication failed.");
    }

    // Auth success! Initialize session
    state.currentUser = data.username;
    localStorage.setItem("transcript-studio-active-user", data.username);

    els.userName.textContent = data.username;
    els.userAvatar.textContent = data.username.charAt(0).toUpperCase();
    els.userGreeting.classList.remove("hidden");

    if (els.video.src) {
      els.video.pause();
      els.video.removeAttribute("src");
      els.video.load();
    }

    els.loginWall.style.opacity = "0";
    els.loginWall.style.transform = "scale(0.95)";
    setTimeout(() => {
      els.loginWall.classList.add("hidden");
      els.loginWall.style.opacity = "";
      els.loginWall.style.transform = "";
      els.appShell.classList.remove("hidden");
      restore();
    }, 200);

  } catch (error) {
    els.authError.textContent = error.message;
    els.authError.classList.remove("hidden");
  } finally {
    els.authSubmitBtn.disabled = false;
    els.authSubmitBtn.textContent = state.authMode === "login" ? "Sign In" : "Create Account";
  }
}

function handleSignOut() {
  if (!confirm("Are you sure you want to sign out?")) return;

  state.currentUser = null;
  localStorage.removeItem("transcript-studio-active-user");
  state.projects = [];
  state.activeProjectId = null;
  state.cues = [];
  state.chatHistory = [];

  els.projectTitle.value = "Untitled interview";
  els.speakerName.value = "Speaker 1";
  els.notes.value = "";
  els.rawTranscript.value = "";
  els.cueCount.textContent = "0";
  els.wordCount.textContent = "0";
  els.durationText.textContent = "0:00";
  els.historyList.textContent = "";
  els.brainMessages.textContent = "";
  els.brainChatEmpty.classList.remove("hidden");
  els.brainMessages.classList.add("hidden");
  renderCues();

  if (els.video.src) {
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.load();
  }

  els.authUsername.value = "";
  els.authPassword.value = "";
  els.authError.classList.add("hidden");

  els.appShell.classList.add("hidden");
  els.loginWall.classList.remove("hidden");
  setAuthMode("login");
}

els.tabSignIn.addEventListener("click", () => setAuthMode("login"));
els.tabSignUp.addEventListener("click", () => setAuthMode("register"));
els.authForm.addEventListener("submit", handleAuthSubmit);
els.signOutBtn.addEventListener("click", handleSignOut);


// Session Restoration on Page Load
const isLiveWorker = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";

if (isLiveWorker && els.signOutBtn) {
  els.signOutBtn.style.display = "none";
}

if (isLiveWorker) {
  // ── Live Cloudflare Worker: skip the login wall entirely ──────────────────
  // This is a personal single-user tool. Auto-login directly into the workspace.
  const savedUser = localStorage.getItem("transcript-studio-active-user") || "Richard";
  localStorage.setItem("transcript-studio-active-user", savedUser);
  state.currentUser = savedUser;
  els.userName.textContent = savedUser;
  els.userAvatar.textContent = savedUser.charAt(0).toUpperCase();
  els.userGreeting.classList.remove("hidden");
  els.loginWall.classList.add("hidden");
  els.appShell.classList.remove("hidden");
  restore();
} else {
  // ── Local dev: check for a saved login session ────────────────────────────
  const activeUser = localStorage.getItem("transcript-studio-active-user");
  if (activeUser) {
    state.currentUser = activeUser;
    els.userName.textContent = activeUser;
    els.userAvatar.textContent = activeUser.charAt(0).toUpperCase();
    els.userGreeting.classList.remove("hidden");
    els.loginWall.classList.add("hidden");
    els.appShell.classList.remove("hidden");
    restore();
  } else {
    els.loginWall.classList.remove("hidden");
    els.appShell.classList.add("hidden");
    setAuthMode("login");
  }
}

updateStartButton();

