const sampleTranscript = `[00:00] Host: Welcome to the launch review. Today we are checking the pacing, key claims, and quotes for the final cut.
[00:08] Guest: The biggest shift is that viewers want useful clips faster, but they still expect accuracy and context.
[00:17] Host: That is exactly why the transcript matters. It becomes the map for edits, captions, and follow-up notes.
[00:27] Guest: I would mark this answer as a pull quote because it explains the product in one clean sentence.
[00:37] Host: Great. We will export this as text first, then send a subtitle file to the editing team.`;

const state = {
  cues: [],
  activeIndex: -1,
  videoFile: null,
  isTranscribing: false,
  lastFinalTranscript: "",
  chatHistory: [],
  isThinking: false,
  activeProjectId: null,
  projects: [],
  geminiModel: "gemini-2.5-flash",
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
  transcriptLanguage: document.querySelector("#transcriptLanguage"),
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
  apiKeyInput: document.querySelector("#apiKeyInput"),
};

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
      start = cues.length ? cues[cues.length - 1].start + 8 : 0;
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
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
}

function renderCues() {
  const query = els.searchInput.value.trim();
  const visible = state.cues.filter((cue) => {
    const haystack = `${cue.speaker} ${cue.text}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  els.emptyState.classList.toggle("hidden", state.cues.length > 0);
  els.cueList.innerHTML = visible
    .map((cue) => {
      const index = state.cues.indexOf(cue);
      const active = index === state.activeIndex ? " active" : "";
      return `<button class="cue${active}" type="button" data-index="${index}">
        <span class="cue-time">${formatTime(cue.start)}</span>
        <p><span class="cue-speaker">${highlight(cue.speaker, query)}:</span> ${highlight(cue.text, query)}</p>
      </button>`;
    })
    .join("");

  updateStats();
}

function updateStats() {
  const words = state.cues.reduce((sum, cue) => sum + cue.text.split(/\s+/).filter(Boolean).length, 0);
  const duration = els.video.duration || (state.cues.length ? state.cues[state.cues.length - 1].start : 0);
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

async function startAutoTranscription() {
  if (!state.videoFile) {
    setRecordingStatus("Add a video first, then press Start.", "error");
    return;
  }

  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    setRecordingStatus("Please enter your Google AI Studio API Key in the panel above first!", "error");
    return;
  }

  state.isTranscribing = true;
  state.lastFinalTranscript = "";
  updateStartButton();
  setTab("review");
  setRecordingStatus("Initiating secure upload session with Google...", "live");

  const mimeType = state.videoFile.type || "application/octet-stream";
  const language = els.transcriptLanguage.value;

  let fileName = null;

  try {
    els.video.play().catch(() => {});

    // 1. Start Resumable Session with Gemini Files API
    const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(state.videoFile.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file: {
          display_name: state.videoFile.name || "video.mp4",
        }
      })
    });

    if (!initRes.ok) {
      const errText = await initRes.text();
      throw new Error(`Failed to initiate file upload session with Google: ${errText}`);
    }

    const uploadUrl = initRes.headers.get("x-goog-upload-url") || initRes.headers.get("X-Goog-Upload-URL");
    if (!uploadUrl) {
      throw new Error("No upload URL received from Gemini Files API in headers.");
    }

    // 2. Stream Binary Bytes to Gemini Files API with progress monitoring
    const fileMeta = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", uploadUrl);
      
      xhr.setRequestHeader("X-Goog-Upload-Offset", "0");
      xhr.setRequestHeader("X-Goog-Upload-Command", "upload, finalize");

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          setRecordingStatus(`Uploading media directly to Google Files API: ${percent}%...`, "live");
        }
      });

      xhr.addEventListener("load", () => {
        let parsed;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = { error: xhr.responseText };
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error?.message || parsed.error || "Failed to upload file bytes to Google."));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Network upload error occurred. Please check your connection.")));
      xhr.send(state.videoFile);
    });

    const fileUri = fileMeta.file?.uri;
    fileName = fileMeta.file?.name;
    if (!fileUri) {
      throw new Error("No file URI received after upload.");
    }

    setRecordingStatus("Upload completed! Google is processing your media file...", "live");

    // 3. Poll file status until it is ACTIVE
    let fileState = "PROCESSING";
    const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
    
    for (let attempt = 0; attempt < 45; attempt++) {
      const checkRes = await fetch(checkUrl);
      if (checkRes.ok) {
        const checkMeta = await checkRes.json();
        fileState = checkMeta.file?.state || checkMeta.state || "ACTIVE";
        setRecordingStatus(`Processing media: ${fileState}...`, "live");
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

    setRecordingStatus("AI is now transcribing and speaker-diarizing...", "live");

    // 4. Generate Content (transcription)
    const promptText = `Transcribe the uploaded media file precisely in the language: ${languageCode(language)}.
Diarize the audio by detecting separate speakers and labeling them (e.g. Speaker 1, Speaker 2).
Output the final transcript as a structured JSON object according to the response schema.`;

    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${state.geminiModel}:generateContent?key=${apiKey}`;
    
    const generateRes = await fetch(generateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
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
      })
    });

    const raw = await generateRes.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: { message: raw } };
    }

    if (!generateRes.ok) {
      throw new Error(data.error?.message || data.error || "Gemini content generation failed.");
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

    state.cues = normalizeAiCues(cues, text);
    els.rawTranscript.value = serializeTranscript();
    renderCues();
    persist();
    setRecordingStatus(`AI transcript ready using Gemini 2.5 Flash! Review or export it!`);
  } catch (error) {
    setRecordingStatus(error.message, "error");
  } finally {
    // 5. Cleanup uploaded File in background
    if (fileName) {
      fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, {
        method: "DELETE"
      }).catch(() => {});
    }
    state.isTranscribing = false;
    updateStartButton();
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
  project.notes = els.notes.value.trim();
  project.transcript = els.rawTranscript.value;
  project.language = els.transcriptLanguage.value;
  project.chatHistory = state.chatHistory || [];
  project.updatedAt = Date.now();

  // Enforce limit of 40 projects
  state.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  while (state.projects.length > 40) {
    state.projects.pop();
  }

  localStorage.setItem("transcript-studio-projects", JSON.stringify(state.projects));
  localStorage.setItem("transcript-studio-active-id", String(state.activeProjectId));
  localStorage.setItem("transcript-studio-theme", document.documentElement.dataset.theme || "light");
  localStorage.setItem("transcript-studio-api-key", els.apiKeyInput.value.trim());

  renderHistoryList();
}

function restore() {
  const savedTheme = localStorage.getItem("transcript-studio-theme");
  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme;
  }

  const rawProjects = localStorage.getItem("transcript-studio-projects");
  const savedActiveId = localStorage.getItem("transcript-studio-active-id");
  els.apiKeyInput.value = localStorage.getItem("transcript-studio-api-key") || "";

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
      speaker: "Speaker 1",
      notes: "",
      transcript: "",
      language: "my-MM",
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
  state.videoFile = file;
  els.video.src = URL.createObjectURL(file);
  els.video.load();
  els.projectTitle.value = file.name.replace(/\.[^.]+$/, "");
  setRecordingStatus("Video loaded. Press Start to send it to AI transcription.");
  persist();
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
  const error = els.video.error;
  const messages = {
    1: "Video loading was cancelled. Choose the video file again.",
    2: "The browser could not load this video from disk. Choose it again, or try MP4/M4A/WAV audio.",
    3: "The browser could not decode this video format. Try MP4, M4A, MP3, or WAV.",
    4: "This video format is not supported by the browser. Try MP4, M4A, MP3, or WAV.",
  };
  setRecordingStatus(messages[error?.code] || "Unable to load the video file. Choose it again, or try MP4/M4A/WAV.", "error");
});
/* ==========================================================================
   AI Brain Workspace Core Logic
   ========================================================================== */

function parseMarkdown(text) {
  let html = text
    .replace(/[&<>"']/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
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
    els.brainMessages.innerHTML = "";
    return;
  }

  els.brainMessages.innerHTML = state.chatHistory
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

  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    state.chatHistory.push({ role: "assistant", text: "❌ **Error**: Please enter your Gemini API Key in the panel on the left side first to start chatting!" });
    renderChatMessages();
    return;
  }

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
    const systemPrompt = `You are the "Transcript Studio Brain", an expert AI editor and video content analyst.
You help users review video transcripts, extract insights, draft summaries, generate chapters/timelines, find compelling pull quotes, and write social media copy.

Here is the current video context to help you answer:
---
[PROJECT NOTES]
${els.notes.value || "(No notes yet)"}
---
[VIDEO TRANSCRIPT]
${els.rawTranscript.value || "(No transcript yet)"}
---

INSTRUCTIONS:
1. Provide highly structured, clear, and action-oriented answers.
2. Use markdown formatting (headers, bold, lists, blockquotes, code blocks) to make your response visually compelling.
3. Be direct, concise, and professional. Avoid meta-commentary.
4. Keep the timeline format clear (e.g. "[MM:SS] - Topic Description") if asked to create chapters.
5. If the transcript is empty or the user asks general questions, assist them as best as possible.`;

    const contents = [];
    if (Array.isArray(state.chatHistory)) {
      for (const h of state.chatHistory.slice(0, -1)) {
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
      parts: [{ text: messageText }]
    });

    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${state.geminiModel}:generateContent?key=${apiKey}`;
    
    const response = await fetch(generateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: contents,
        generationConfig: {
          temperature: 0.3
        }
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "Gemini chat generation failed.");
    }

    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    state.chatHistory.push({ role: "assistant", text: responseText });
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
  const msg = state.chatHistory[index];
  if (!msg) return;
  navigator.clipboard.writeText(msg.text).then(() => {
    const btn = document.querySelector(`#btn-copy-${index}`);
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = "Copied! ✓";
      btn.style.color = "var(--accent-strong)";
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.style.color = "";
      }, 1200);
    }
  });
};

window.applyMessageToNotes = (index) => {
  const msg = state.chatHistory[index];
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
    btn.innerHTML = "Applied! ✓";
    btn.style.color = "var(--accent-strong)";
    setTimeout(() => {
      btn.innerHTML = orig;
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
  els.notes.value = project.notes || "";
  els.transcriptLanguage.value = project.language || "my-MM";
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
    els.historyList.innerHTML = `<div style="text-align: center; color: var(--muted); font-size: 12px; padding: 12px;">No saved projects</div>`;
    return;
  }

  els.historyList.innerHTML = state.projects
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
}

window.selectProject = (projectId) => {
  state.activeProjectId = projectId;
  if (els.video.src) {
    els.video.pause();
    els.video.src = "";
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
    els.video.src = "";
  }
  
  loadActiveProject();
  persist();

  els.projectTitle.focus();
  els.projectTitle.select();
}

[els.projectTitle, els.speakerName, els.transcriptLanguage, els.notes, els.rawTranscript, els.apiKeyInput].forEach((el) => {
  el.addEventListener("input", persist);
});

els.newProjectBtn.addEventListener("click", createNewProject);

restore();
updateStartButton();
