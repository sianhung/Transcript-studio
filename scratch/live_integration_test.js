const fs = require('fs');
const path = require('path');

// 1. Generate a valid 2-second mono 16-bit 8000Hz PCM WAV file of silence
function generateSilenceWav() {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const durationSeconds = 2;
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt 
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // The rest is filled with zeroes (silence)
  return buffer;
}

const API_BASE = 'https://transcript-studio.penglambot.workers.dev';

async function run() {
  console.log('[Test] Generating valid WAV file of silence...');
  const wavBuffer = generateSilenceWav();
  const wavPath = path.join(__dirname, 'silence_test.wav');
  fs.writeFileSync(wavPath, wavBuffer);
  console.log(`[Test] Saved WAV to ${wavPath} (${wavBuffer.length} bytes)`);

  try {
    // Phase 1: Upload Session initiation
    console.log('\n[Test Phase 1] Requesting live upload session...');
    const sessionRes = await fetch(`${API_BASE}/api/upload-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'silence_test.wav',
        fileSize: wavBuffer.length,
        mimeType: 'audio/wav',
        startKeyIndex: 0
      })
    });

    const sessionData = await sessionRes.json();
    if (!sessionRes.ok || sessionData.error) {
      throw new Error(`Upload session failed: ${JSON.stringify(sessionData)}`);
    }

    console.log('[Test Phase 1] SUCCESS! Session Data:', sessionData);
    const { uploadUrl, keyIndex } = sessionData;

    // Phase 2: Chunk Upload proxying
    console.log('\n[Test Phase 2] Uploading media via live proxy...');
    const uploadProxyUrl = `${API_BASE}/api/upload-proxy?uploadUrl=${encodeURIComponent(uploadUrl)}`;
    const uploadRes = await fetch(uploadProxyUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Protocol': 'resumable',
        'Content-Type': 'audio/wav',
        'X-Goog-Upload-Content-Type': 'audio/wav',
      },
      body: wavBuffer
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || uploadData.error) {
      throw new Error(`Media upload failed: ${JSON.stringify(uploadData)}`);
    }

    console.log('[Test Phase 2] SUCCESS! Media Upload Response:', uploadData);

    // Phase 3: Status check polling
    console.log('\n[Test Phase 3] Polling file status...');
    const fileName = uploadData.file.name;
    const fileUri = uploadData.file.uri;
    let isActive = false;
    let attempts = 0;

    while (!isActive && attempts < 10) {
      attempts++;
      console.log(`[Test Phase 3] Polling attempt ${attempts}...`);
      const statusRes = await fetch(`${API_BASE}/api/file-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName,
          keyIndex
        })
      });

      const statusData = await statusRes.json();
      if (!statusRes.ok || statusData.error) {
        throw new Error(`File status failed: ${JSON.stringify(statusData)}`);
      }

      console.log(`[Test Phase 3] Status state: ${statusData.state}`);
      if (statusData.state === 'ACTIVE') {
        isActive = true;
        break;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (!isActive) {
      throw new Error('File processing timed out without reaching ACTIVE state.');
    }
    console.log('[Test Phase 3] SUCCESS! File is ACTIVE.');

    // Phase 4: Transcription test
    console.log('\n[Test Phase 4] Requesting live transcription...');
    const transcribeRes = await fetch(`${API_BASE}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileUri,
        fileName,
        language: 'en',
        mimeType: 'audio/wav',
        speakerMode: 'none',
        geminiModel: 'gemini-3.5-flash',
        keyIndex
      })
    });

    const transcribeData = await transcribeRes.json();
    if (!transcribeRes.ok || transcribeData.error) {
      throw new Error(`Transcription failed: ${JSON.stringify(transcribeData)}`);
    }

    console.log('[Test Phase 4] SUCCESS! Transcription response text:');
    console.log('----------------------------------------------------');
    console.log(transcribeData.text || '(empty response or silence)');
    console.log('----------------------------------------------------');
    console.log('[Test] END-TO-END INTEGRATION TEST PASSED SUCCESSFULLY! 🎉');

  } catch (err) {
    console.error('\n[Test] ❌ INTEGRATION TEST FAILED:', err.message);
    process.exit(1);
  } finally {
    // Cleanup local temp file
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

run();
