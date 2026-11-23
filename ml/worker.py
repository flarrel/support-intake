"""Persistent line-delimited JSON inference process for the JavaScript app."""

import json
import sys

import torch

from .model import IntentModel
from .ocr import CorruptImageError, ScreenshotReader


def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    torch.set_num_threads(1)
    model = IntentModel()
    reader = ScreenshotReader()
    send({"ready": True, "labels": model.labels})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Expected a text or screenshot request.")
            if set(request) == {"text"} and isinstance(request["text"], str):
                text = request["text"].strip()
            elif set(request) == {"imagePath"} and isinstance(request["imagePath"], str):
                text = reader.read(request["imagePath"])
            else:
                raise ValueError("Expected a text or screenshot request.")
            send(model.predict(text))
        except CorruptImageError as error:
            send({"error": str(error), "code": "INVALID_IMAGE"})
        except (json.JSONDecodeError, ValueError):
            send({"error": "Expected a text or screenshot request.", "code": "INVALID_REQUEST"})
        except Exception as error:
            print(f"Inference failed: {type(error).__name__}", file=sys.stderr, flush=True)
            send({"error": "Inference failed.", "code": "INFERENCE_FAILED"})


if __name__ == "__main__":
    main()
