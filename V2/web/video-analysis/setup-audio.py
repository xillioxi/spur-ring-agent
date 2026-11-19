"""Provision the small official YAMNet assets; does not install Python packages."""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / ".build-tools" / "models" / "yamnet"
ASSETS = (
    ("yamnet-classification.tflite",
     "https://storage.googleapis.com/download.tensorflow.org/models/tflite/task_library/audio_classification/android/lite-model_yamnet_classification_tflite_1.tflite",
     4_126_810, "10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de"),
    ("yamnet_class_map.csv",
     "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv",
     14_096, "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2"),
)


def main():
    destination = DESTINATION.resolve()
    if not destination.is_relative_to(ROOT.resolve()):
        raise ValueError("The model directory must remain inside the workspace")
    destination.mkdir(parents=True, exist_ok=True)
    for name, url, size, checksum in ASSETS:
        target = destination / name
        if target.is_symlink():
            raise ValueError("Model assets must be regular files")
        if target.exists():
            if target.stat().st_size != size or hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
                raise ValueError("An existing model asset has an unexpected checksum; it was preserved")
            continue
        with urlopen(Request(url, headers={"User-Agent": "Spur-local-audio-setup/1"}), timeout=30) as response:
            data = response.read(size + 1)
        if len(data) != size or hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError("The downloaded model asset did not match its expected size and checksum")
        # Exclusive creation avoids replacing an asset created by another setup process.
        with target.open("xb") as output:
            output.write(data)
    print(json.dumps({"model": str(destination / ASSETS[0][0]), "labels": str(destination / ASSETS[1][0]),
                      "downloadBytes": sum(item[2] for item in ASSETS),
                      "runtime": "Requires an existing Python with TensorFlow and NumPy"}))


if __name__ == "__main__":
    main()
