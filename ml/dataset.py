"""Fetch the published Banking77 split from PolyAI's dataset repository."""

import csv
import hashlib
import io
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

REVISION = "9d081458ff52e53cf7e848f414e6e9344e4e6696"
SOURCE = "https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets"
FILES = {
    "train.csv": (10003, "b06e26ac675513959a63135f11b94ea7786ed02da65db93a5650d8838cbc664b"),
    "test.csv": (3080, "d12d6e3bc4c3103966ae786dc435913c0c563dfa328f5a3646d0e62cfeeb474d"),
}
DEFAULT_RUNTIME = Path(__file__).resolve().parents[2] / "runtime"
RUNTIME = Path(os.environ.get("SUPPORT_RUNTIME", DEFAULT_RUNTIME)).resolve()
MODEL_RUNTIME = Path(os.environ.get("SUPPORT_MODEL_RUNTIME", RUNTIME)).resolve()


def records(payload, expected):
    reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
    if reader.fieldnames != ["text", "category"]:
        raise ValueError("Unexpected Banking77 CSV header")
    rows = [(row["text"], row["category"]) for row in reader]
    if len(rows) != expected or any(not text or not label for text, label in rows):
        raise ValueError("Unexpected Banking77 rows")
    return rows


def verify(payload, name):
    count, expected = FILES[name]
    if hashlib.sha256(payload).hexdigest() != expected:
        raise ValueError(f"Banking77 {name} does not match the pinned SHA-256")
    return records(payload, count)


def load_splits():
    folder = RUNTIME / "banking77"
    return [verify((folder / name).read_bytes(), name) for name in FILES]


def main():
    folder = RUNTIME / "banking77"
    folder.mkdir(parents=True, exist_ok=True)
    for name, (count, digest) in FILES.items():
        path = folder / name
        if path.is_file():
            verify(path.read_bytes(), name)
        else:
            with urlopen(f"{SOURCE}/{REVISION}/banking_data/{name}", timeout=30) as response:
                payload = response.read(2_000_001)
            if len(payload) > 2_000_000:
                raise ValueError("Unexpected Banking77 response size")
            verify(payload, name)
            with NamedTemporaryFile(dir=folder, delete=False) as pending:
                temporary = Path(pending.name)
                try:
                    pending.write(payload)
                    pending.close()
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
        print(f"{path.name} {count} rows SHA-256 {digest}")


if __name__ == "__main__":
    main()
