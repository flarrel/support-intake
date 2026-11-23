"""Compare OCR paths using reproducible renders of a held-out text sample."""

from collections import defaultdict
from hashlib import sha256
import random
import re

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import torch

from .dataset import RUNTIME, load_splits
from .model import IntentModel
from .ocr import ScreenshotReader
from .train import save_json

STYLES = {
    "light": ("#ffffff", "#181b20", 0),
    "dark": ("#202934", "#eeeeee", 0),
    "low-contrast": ("#dddddd", "#828282", 0.5),
}


def render(text, style, output):
    background, foreground, blur = STYLES[style]
    font = ImageFont.load_default(size=30)
    lines, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if font.getlength(candidate) > 740 and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    image = Image.new("RGB", (800, max(120, len(lines) * 46 + 48)), background)
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((30, 25 + index * 46), line, font=font, fill=foreground)
    if blur:
        image = image.filter(ImageFilter.GaussianBlur(blur))
    image.save(output)


def normalize(text):
    return re.sub(r"\s+", " ", text.casefold()).strip()


def edit_distance(source, target):
    previous = list(range(len(target) + 1))
    for i, expected in enumerate(source, start=1):
        current = [i]
        for j, received in enumerate(target, start=1):
            current.append(min(
                previous[j] + 1,
                current[-1] + 1,
                previous[j - 1] + (expected != received),
            ))
        previous = current
    return previous[-1]


def summarize(records):
    total = len(records)
    auto_routed = [record for record in records if not record["needsReview"]]
    return {
        "examples": total,
        "characterErrorRate": (
            sum(item["characterErrors"] for item in records)
            / sum(item["expectedCharacters"] for item in records)
        ),
        "wordErrorRate": (
            sum(item["wordErrors"] for item in records)
            / sum(item["expectedWords"] for item in records)
        ),
        "intentAccuracy": sum(item["correctIntent"] for item in records) / total,
        "matchesDirectTextIntent": sum(item["matchesDirectTextIntent"] for item in records) / total,
        "automaticCoverage": len(auto_routed) / total,
        "automaticAccuracy": (
            sum(item["correctIntent"] for item in auto_routed) / len(auto_routed)
            if auto_routed else None
        ),
        "blankRecognitions": sum(item["blankRecognition"] for item in records),
    }


def main():
    torch.set_num_threads(1)
    _, test_rows = load_splits()
    model = IntentModel()
    reader = ScreenshotReader()
    by_intent = defaultdict(list)
    for text, intent in test_rows:
        by_intent[intent].append(text)
    rng = random.Random(42)
    folder = RUNTIME / "screenshot-fixtures"
    folder.mkdir(parents=True, exist_ok=True)
    paths = {"raw": [], "preprocessed": []}
    direct_correct = 0
    for index, (intent, candidates) in enumerate(sorted(by_intent.items())):
        text = rng.choice(candidates)
        expected = normalize(text)
        direct = model.predict(text)
        direct_correct += direct["intent"] == intent
        style = tuple(STYLES)[index % len(STYLES)]
        file = folder / f"{index:02d}-{style}.png"
        render(text, style, file)
        for variant, results in paths.items():
            recognized = reader.read(file, preprocess=variant == "preprocessed")
            normalized = normalize(recognized)
            result = model.predict(recognized)
            results.append({
                "image": file.name,
                "imageSha256": sha256(file.read_bytes()).hexdigest(),
                "style": style,
                "expectedIntent": intent,
                "predictedIntent": result["intent"],
                "expectedCharacters": len(expected),
                "expectedWords": len(expected.split()),
                "characterErrors": edit_distance(expected, normalized),
                "wordErrors": edit_distance(expected.split(), normalized.split()),
                "correctIntent": result["intent"] == intent,
                "matchesDirectTextIntent": result["intent"] == direct["intent"],
                "needsReview": result["needsReview"],
                "blankRecognition": not recognized,
            })
    report = {
        "sample": "One seeded held-out utterance per intent rendered on three browser-like styles",
        "seed": 42,
        "directTextIntentAccuracy": direct_correct / len(by_intent),
        "variants": {
            name: {
                "overall": summarize(results),
                "byStyle": {
                    style: summarize([item for item in results if item["style"] == style])
                    for style in STYLES
                },
                "records": results,
            }
            for name, results in paths.items()
        },
    }
    save_json(RUNTIME / "evaluation-images.json", report)
    print({
        name: values["overall"] for name, values in report["variants"].items()
    })


if __name__ == "__main__":
    main()
