"""Read screenshot text with RapidOCR's bundled ONNX detection and recognition."""

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from rapidocr_onnxruntime import RapidOCR

MAX_IMAGE_PIXELS = 12_000_000
MAX_OUTPUT_CHARACTERS = 4000


class CorruptImageError(ValueError):
    pass


class ScreenshotReader:
    def __init__(self):
        self.engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)

    def read(self, file, *, preprocess=True):
        try:
            with Image.open(file) as source:
                if source.format not in {"PNG", "JPEG"}:
                    raise CorruptImageError("Upload a PNG or JPEG screenshot.")
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise CorruptImageError("The screenshot exceeds 12 megapixels.")
                image = ImageOps.exif_transpose(source).convert("RGBA")
                white = Image.new("RGBA", image.size, "white")
                white.alpha_composite(image)
                image = white.convert("RGB")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise CorruptImageError("The screenshot could not be read.") from error

        # RapidOCR expects BGR arrays. Keep OCR preprocessing independent of
        # training so the raw and enhanced paths can be compared directly.
        pixels = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        if preprocess:
            grey = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
            if grey.mean() < 110:
                grey = cv2.bitwise_not(grey)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            pixels = cv2.cvtColor(clahe.apply(grey), cv2.COLOR_GRAY2BGR)
        detections, _ = self.engine(pixels)
        return " ".join(item[1] for item in detections or ())[:MAX_OUTPUT_CHARACTERS].strip()
