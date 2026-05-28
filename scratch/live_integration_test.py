import os
import sys
import wave
import time
import requests

import argparse

# Parse arguments
parser = argparse.ArgumentParser(description="Transcript Studio integration test")
parser.add_argument("--url", default="http://127.0.0.1:4173", help="Base URL for the API (default: http://127.0.0.1:4173)")
parser.add_argument("--live", action="store_true", help="Target the live Cloudflare Worker instead of local host")
args, unknown = parser.parse_known_args()

API_BASE = 'https://transcript-studio.penglambot.workers.dev' if args.live else args.url

def generate_silence_wav(filepath):
    """Generates a valid 2-second mono 16-bit 8000Hz PCM WAV file of silence."""
    sample_rate = 8000
    num_channels = 1
    bits_per_sample = 16
    duration_seconds = 2
    num_samples = sample_rate * duration_seconds
    data_size = num_samples * num_channels * (bits_per_sample // 8)
    
    # Silence is represented by zero bytes in PCM 16-bit
    data = b'\x00' * data_size
    
    with wave.open(filepath, 'wb') as wav_file:
        wav_file.setnchannels(num_channels)
        wav_file.setsampwidth(bits_per_sample // 8)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(data)

def run_test_for_key_index(wav_path, key_index):
    """Runs the end-to-end integration test flow for a specific Gemini API key index."""
    with open(wav_path, 'rb') as f:
        wav_bytes = f.read()

    print(f"\n--- Starting Integration Test (Key Index: {key_index}) ---")

    # Phase 1: Upload Session initiation
    print("\n[Test Phase 1] Requesting live upload session...")
    session_res = requests.post(
        f"{API_BASE}/api/upload-session",
        json={
            "fileName": "silence_test.wav",
            "fileSize": len(wav_bytes),
            "mimeType": "audio/wav",
            "startKeyIndex": key_index
        }
    )
    
    if session_res.status_code != 200:
        raise Exception(f"Upload session failed with status {session_res.status_code}: {session_res.text}")
    
    session_data = session_res.json()
    if "error" in session_data:
        raise Exception(f"Upload session returned error: {session_data['error']}")
    
    print("[Test Phase 1] SUCCESS! Session Data:", session_data)
    upload_url = session_data["uploadUrl"]
    actual_key_index = session_data["keyIndex"]

    # Phase 2: Chunk Upload proxying
    print("\n[Test Phase 2] Uploading media via live proxy...")
    upload_proxy_url = f"{API_BASE}/api/upload-proxy"
    upload_res = requests.post(
        upload_proxy_url,
        params={"uploadUrl": upload_url},
        headers={
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Protocol': 'resumable',
            'Content-Type': 'audio/wav',
            'X-Goog-Upload-Content-Type': 'audio/wav',
        },
        data=wav_bytes
    )

    if upload_res.status_code != 200:
        raise Exception(f"Media upload failed with status {upload_res.status_code}: {upload_res.text}")

    upload_data = upload_res.json()
    if "error" in upload_data:
        raise Exception(f"Media upload returned error: {upload_data['error']}")

    print("[Test Phase 2] SUCCESS! Media Upload Response:", upload_data)
    file_name = upload_data["file"]["name"]
    file_uri = upload_data["file"]["uri"]

    # Phase 3: Status check polling
    print("\n[Test Phase 3] Polling file status...")
    is_active = False
    for attempt in range(1, 11):
        print(f"[Test Phase 3] Polling attempt {attempt}...")
        status_res = requests.post(
            f"{API_BASE}/api/file-status",
            json={
                "fileName": file_name,
                "keyIndex": actual_key_index
            }
        )

        if status_res.status_code != 200:
            raise Exception(f"File status check failed with status {status_res.status_code}: {status_res.text}")

        status_data = status_res.json()
        if "error" in status_data:
            raise Exception(f"File status check returned error: {status_data['error']}")

        print(f"[Test Phase 3] Status state: {status_data.get('state')}")
        if status_data.get('state') == 'ACTIVE':
            is_active = True
            break

        time.sleep(2)

    if not is_active:
        raise Exception("File processing timed out without reaching ACTIVE state.")
    
    print("[Test Phase 3] SUCCESS! File is ACTIVE.")

    # Phase 4: Transcription test
    print("\n[Test Phase 4] Requesting live transcription...")
    max_retries = 3
    for retry_attempt in range(1, max_retries + 1):
        transcribe_res = requests.post(
            f"{API_BASE}/api/transcribe",
            json={
                "fileUri": file_uri,
                "fileName": file_name,
                "language": "en",
                "mimeType": "audio/wav",
                "speakerMode": "none",
                "geminiModel": "gemini-2.5-flash",
                "keyIndex": actual_key_index
            }
        )

        transcribe_data = transcribe_res.json()
        if transcribe_res.status_code == 200 and "error" not in transcribe_data:
            break

        err_msg = transcribe_data.get("error", transcribe_res.text)
        
        # Check for rate limit or quota error
        if "quota" in err_msg.lower() or "limit" in err_msg.lower() or "retry" in err_msg.lower():
            import re
            match = re.search(r"[Pp]lease\s+retry\s+in\s+([\d\.]+)\s*(?:s|ms)?", err_msg)
            if match and retry_attempt < max_retries:
                raw_val = float(match.group(1))
                # If the units are ms, convert to seconds
                if "ms" in err_msg.lower() and not re.search(r"(\b\d+\s*s\b)", err_msg.lower()):
                    wait_secs = (raw_val / 1000.0) + 1.0
                else:
                    wait_secs = raw_val + 1.5
                print(f"[Warning] Quota limit reached. Sleeping for {wait_secs:.2f} seconds before retry {retry_attempt}/{max_retries}...")
                time.sleep(wait_secs)
                continue
            elif retry_attempt < max_retries:
                print(f"[Warning] Quota limit reached. Sleeping for 15 seconds before retry {retry_attempt}/{max_retries}...")
                time.sleep(15)
                continue

        raise Exception(f"Transcription failed: {err_msg}")

    print("[Test Phase 4] SUCCESS! Transcription response text:")
    print("----------------------------------------------------")
    print(transcribe_data.get("text") or "(empty response or silence)")
    print("----------------------------------------------------")
    print("[Test] END-TO-END INTEGRATION TEST PASSED SUCCESSFULLY! 🎉")
    return True

def main():
    print("[Test] Generating valid WAV file of silence...")
    scratch_dir = os.path.dirname(os.path.abspath(__file__))
    wav_path = os.path.join(scratch_dir, 'silence_test.wav')
    
    try:
        generate_silence_wav(wav_path)
        print(f"[Test] Saved WAV to {wav_path} ({os.path.getsize(wav_path)} bytes)")
    except Exception as e:
        print(f"[Test] ❌ Failed to generate WAV: {e}")
        sys.exit(1)

    # We will try indices 0, 1, 2 (the 3 API keys in rotation)
    keys_to_try = [0, 1, 2]
    success = False
    
    for key_index in keys_to_try:
        try:
            success = run_test_for_key_index(wav_path, key_index)
            if success:
                break
        except ValueError as qe:
            print(f"[Retry] Rate/quota limit hit with key {key_index}. Retrying with next key...")
        except Exception as e:
            print(f"[Test] ❌ Phase failure with key {key_index}: {e}")
            print("Retrying with next key index...")

    # Cleanup local temp file
    try:
        if os.path.exists(wav_path):
            os.remove(wav_path)
            print("[Test] Cleaned up silence_test.wav local file.")
    except Exception as e:
        print(f"[Test] [Warning] Failed to delete temp file: {e}")

    if success:
        print("\n🎉 INTEGRATION TEST PASSED SUCCESSFULLY across the key rotation pool!")
        sys.exit(0)
    else:
        print("\n❌ INTEGRATION TEST FAILED: All available key indexes in pool returned errors or were exhausted.")
        sys.exit(1)

if __name__ == "__main__":
    main()
