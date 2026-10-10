"""Trích chữ của nhiều file PDF cho ô tìm kiếm trong VsScience (PyMuPDF đi kèm app).

  python pdftext.py <a.pdf> [<b.pdf> …]

In mỗi file một dòng JSON: {"file": "<đường dẫn>", "pages": ["chữ trang 1", …]} hoặc {"file": …, "error": "…"}.
"""

import json
import os
import re
import sys
import unicodedata

try:
    import pymupdf as fitz
except ImportError:
    import fitz

MAX_PAGES = 2000


def load_ocr(path: str) -> dict:
    """Chữ nhận dạng từ ảnh trang quét (pdf.py ocr-set): file ẩn .<tên>.ocr.json cạnh PDF."""
    d, name = os.path.split(os.path.abspath(path))
    try:
        with open(os.path.join(d, f".{name}.ocr.json"), encoding="utf-8") as f:
            return {int(k): str(v) for k, v in json.load(f).get("pages", {}).items()}
    except (OSError, ValueError, AttributeError):
        return {}


def main() -> None:
    for path in sys.argv[1:]:
        ocr = load_ocr(path)
        try:
            with fitz.open(path) as doc:
                if doc.needs_pass:
                    raise ValueError("PDF có mật khẩu")
                pages = []
                for i, page in enumerate(doc):
                    if i >= MAX_PAGES:
                        break
                    text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", page.get_text("text"))).strip()
                    if not text and ocr.get(i + 1):
                        text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", ocr[i + 1])).strip()
                    pages.append(text)
            out = {"file": path, "pages": pages}
        except Exception as e:  # noqa: BLE001
            out = {"file": path, "error": str(e)}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
