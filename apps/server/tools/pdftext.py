"""Trích chữ của nhiều file PDF cho ô tìm kiếm trong VsScience (PyMuPDF đi kèm app).

  python pdftext.py <a.pdf> [<b.pdf> …]

In mỗi file một dòng JSON: {"file": "<đường dẫn>", "pages": ["chữ trang 1", …]} hoặc {"file": …, "error": "…"}.
"""

import json
import re
import sys
import unicodedata

try:
    import pymupdf as fitz
except ImportError:
    import fitz

MAX_PAGES = 2000


def main() -> None:
    for path in sys.argv[1:]:
        try:
            with fitz.open(path) as doc:
                if doc.needs_pass:
                    raise ValueError("PDF có mật khẩu")
                pages = []
                for i, page in enumerate(doc):
                    if i >= MAX_PAGES:
                        break
                    text = unicodedata.normalize("NFC", page.get_text("text"))
                    pages.append(re.sub(r"\s+", " ", text).strip())
            out = {"file": path, "pages": pages}
        except Exception as e:  # noqa: BLE001
            out = {"file": path, "error": str(e)}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
