#!/usr/bin/env python3
"""
vosk_worker.py - Persistent offline Vosk transcription worker.
Reads JSON lines from stdin: {"wav": "/path/to/wav"} or {"action": "ping"}
Writes JSON lines to stdout: {"text": "...", "time": 0.23, "ok": true}
Keeps model resident in RAM for instant sub-second recognition.
"""
import sys, json, os, wave, time

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'vosk-model-small-en-us-0.15')

# Number homophones and digit mapping for reCAPTCHA audio challenges
WORD_TO_DIGIT = {
    'zero': '0', 'oh': '0',
    'one': '1', 'won': '1',
    'two': '2', 'to': '2', 'too': '2',
    'three': '3', 'tree': '3',
    'four': '4', 'for': '4', 'fore': '4',
    'five': '5',
    'six': '6', 'sex': '6',
    'seven': '7',
    'eight': '8', 'ate': '8',
    'nine': '9', 'niner': '9'
}

def normalize_transcript(text):
    if not text:
        return ""
    words = text.lower().strip().split()
    if not words:
        return ""
    
    # Check if words are predominantly numbers
    num_matches = sum(1 for w in words if w in WORD_TO_DIGIT or w.isdigit())
    if len(words) > 0 and (num_matches / len(words)) >= 0.5:
        # Convert to digits
        digits = []
        for w in words:
            if w in WORD_TO_DIGIT:
                digits.append(WORD_TO_DIGIT[w])
            elif w.isdigit():
                digits.append(w)
            else:
                digits.append(w)
        return ''.join(digits)
    
    return ' '.join(words)

def main():
    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1) # Suppress Kaldi verbose C++ logs
    except ImportError as e:
        sys.stderr.write(f"vosk import error: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    t0 = time.time()
    try:
        model = Model(MODEL_PATH)
        load_time = time.time() - t0
        sys.stderr.write(f"[vosk_worker] Model loaded in {load_time:.2f}s, ready.\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[vosk_worker] Failed to load model: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    # Signal ready
    print(json.dumps({"ready": True, "load_time": round(load_time, 2)}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        if req.get('action') == 'ping':
            print(json.dumps({"ok": True, "pong": True}), flush=True)
            continue

        req_id = req.get('id')
        wav_file = req.get('wav')
        if not wav_file or not os.path.exists(wav_file):
            resp = {"ok": False, "error": "file_not_found"}
            if req_id is not None:
                resp["id"] = req_id
            print(json.dumps(resp), flush=True)
            continue

        t_start = time.time()
        try:
            with wave.open(wav_file, 'rb') as wf:
                rec = KaldiRecognizer(model, wf.getframerate())
                rec.SetWords(True)
                results = []
                while True:
                    data = wf.readframes(4000)
                    if len(data) == 0:
                        break
                    if rec.AcceptWaveform(data):
                        r = json.loads(rec.Result())
                        if r.get('text'):
                            results.append(r['text'])
                r = json.loads(rec.FinalResult())
                if r.get('text'):
                    results.append(r['text'])

            raw_text = ' '.join(results).strip()
            normalized = normalize_transcript(raw_text)
            elapsed = time.time() - t_start

            resp = {
                "ok": True,
                "text": normalized or raw_text,
                "raw": raw_text,
                "time": round(elapsed, 3)
            }
            if req_id is not None:
                resp["id"] = req_id
            print(json.dumps(resp), flush=True)
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
            if req_id is not None:
                resp["id"] = req_id
            print(json.dumps(resp), flush=True)

if __name__ == '__main__':
    main()
