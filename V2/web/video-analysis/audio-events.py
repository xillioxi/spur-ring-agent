"""Local waveform-only YAMNet inference. No network access or package installation."""
import argparse
import csv
import importlib.util
import json
import os
import sys
import wave

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")


def emit(value):
    print(json.dumps(value, ensure_ascii=True, allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--labels")
    parser.add_argument("--audio")
    args = parser.parse_args()
    if args.check:
        emit({"available": all(importlib.util.find_spec(name) is not None for name in ("numpy", "tensorflow"))})
        return

    import numpy as np
    import tensorflow as tf

    with open(args.labels, encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    if len(rows) != 521 or any(int(row["index"]) != index for index, row in enumerate(rows)):
        raise ValueError("Invalid YAMNet label map")
    labels = [row["display_name"] for row in rows]

    with wave.open(args.audio, "rb") as source:
        if source.getnchannels() != 1 or source.getframerate() != 16000 or source.getsampwidth() != 2:
            raise ValueError("Expected mono 16 kHz PCM audio")
        sample_count = source.getnframes()
        if sample_count < 1 or sample_count > 300 * 16000:
            raise ValueError("Audio duration is outside the supported range")
        samples = np.frombuffer(source.readframes(sample_count), dtype="<i2").astype(np.float32) / 32768.0

    interpreter = tf.lite.Interpreter(model_path=args.model, num_threads=2)
    interpreter.allocate_tensors()
    input_info = interpreter.get_input_details()[0]
    output_info = interpreter.get_output_details()[0]
    if tuple(input_info["shape"]) != (15600,) or input_info["dtype"] != np.float32:
        raise ValueError("Unsupported YAMNet input")
    if tuple(output_info["shape"]) != (1, 521) or output_info["dtype"] != np.float32:
        raise ValueError("Unsupported YAMNet output")

    duration = sample_count / 16000.0
    hop_samples = 7680  # 0.48 seconds, matching the reference YAMNet framing.
    events = []
    windows = 0
    # Keep the final partial window so every audible part of the soundtrack is sampled.
    for offset in range(0, sample_count, hop_samples):
        segment = samples[offset:offset + 15600]
        if segment.size < 15600:
            segment = np.pad(segment, (0, 15600 - segment.size))
        interpreter.set_tensor(input_info["index"], segment)
        interpreter.invoke()
        scores = interpreter.get_tensor(output_info["index"])[0]
        if not np.all(np.isfinite(scores)):
            raise ValueError("Invalid model scores")
        start = offset / 16000.0
        end = min(duration, start + 0.975)
        for index in np.argsort(scores)[-3:][::-1]:
            score = float(scores[index])
            if score >= 0.25:
                events.append({"startSeconds": round(start, 4), "endSeconds": round(end, 4),
                               "label": labels[int(index)], "confidence": round(min(1.0, score), 5)})
        windows += 1

    emit({"durationSeconds": duration, "windowSeconds": 0.975, "hopSeconds": 0.48,
          "windowCount": windows, "threshold": 0.25, "events": events})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not send local paths, model internals or audio content back to HTTP clients.
        emit({"error": "Local audio classification could not process this file."})
        sys.exit(1)
