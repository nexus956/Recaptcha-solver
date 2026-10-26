#!/home/nexus/Desktop/files/venv/bin/python
"""
transcribe.py  –  Transcribe a WAV file using Vosk (offline, free).
Usage: python3 transcribe.py <wav_file>
Prints the transcript to stdout on success, empty string on failure.
"""
import sys, json, os, wave

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'vosk-model-small-en-us-0.15')

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
    num_matches = sum(1 for w in words if w in WORD_TO_DIGIT or w.isdigit())
    if len(words) > 0 and (num_matches / len(words)) >= 0.5:
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

if len(sys.argv) < 2:
    sys.exit(0)

wav_file = sys.argv[1]

try:
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)
    model = Model(MODEL_PATH)
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
    norm = normalize_transcript(raw_text)
    print(norm or raw_text)
except Exception as e:
    sys.exit(0)
