"""Đọc PDF cho Claude trong VsScience (dùng PyMuPDF đi kèm app, không cần poppler/pdftoppm).

  python pdf.py info   <file.pdf>                      số trang, thông tin, mục lục, trang nào là ảnh quét
  python pdf.py text   <file.pdf> [--pages 3-7,10]     chữ theo từng trang, có đánh dấu số trang
  python pdf.py search <file.pdf> "<từ khóa>"          các trang có từ khóa, kèm đoạn trích
  python pdf.py render <file.pdf> --pages 5 --out DIR  chụp trang thành ảnh PNG (xem hình, công thức, bản quét)
  python pdf.py ocr-set <file.pdf> --pages 5 --text-file F  lưu chữ đã đọc từ ảnh trang quét (UTF-8) để lần sau
                                                       đọc/tìm được ngay, không phải chụp lại

Trang ảnh quét đã có chữ lưu bằng ocr-set thì text/search dùng chữ đó (ghi rõ là chữ nhận dạng từ ảnh).

Số trang là số thứ tự trong file (trang 1 là trang đầu tiên); nếu sách in số trang khác thì có ghi kèm.
"""

import argparse
import json
import os
import re
import sys
import unicodedata

MAX_TEXT = 60_000  # ký tự mỗi lần in, tránh tràn ngữ cảnh
MAX_RENDER = 10  # trang mỗi lần chụp


def fail(msg: str) -> None:
    print(f"LỖI: {msg}", file=sys.stderr)
    sys.exit(1)


try:
    import pymupdf as fitz  # PyMuPDF bản mới; tên cũ "fitz" vẫn dùng được nhưng in cảnh báo
except ImportError:
    try:
        import fitz
    except ImportError:
        fail("Máy chưa có thư viện PyMuPDF để đọc PDF.")


def open_pdf(path: str):
    if not os.path.isfile(path):
        fail(f"Không thấy file: {path}")
    try:
        doc = fitz.open(path)
    except Exception as e:  # noqa: BLE001
        fail(f"Không mở được PDF (file hỏng hoặc không phải PDF): {e}")
    if doc.needs_pass:
        fail("PDF có mật khẩu, chưa đọc được.")
    return doc


def parse_pages(spec: str | None, count: int) -> list[int]:
    """'3-7,10' -> [3,4,5,6,7,10] (đánh số từ 1), bỏ trang ngoài phạm vi."""
    if not spec:
        return list(range(1, count + 1))
    pages: list[int] = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start = int(a) if a else 1
            end = int(b) if b else count
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    seen = set()
    return [p for p in pages if 1 <= p <= count and not (p in seen or seen.add(p))]


def label(page) -> str:
    """Số trang in trên sách (nếu PDF có khai báo và khác số thứ tự)."""
    try:
        lb = page.get_label()
    except Exception:  # noqa: BLE001
        return ""
    # Một số PDF ghi nhãn dạng chuỗi UTF-16 hex chưa giải mã: "<FEFF0031>" -> "1".
    m = re.fullmatch(r"<FEFF([0-9A-Fa-f]*)>", lb or "")
    if m:
        try:
            lb = bytes.fromhex(m.group(1)).decode("utf-16-be")
        except ValueError:
            lb = ""
    return f" (sách ghi trang {lb})" if lb and lb != str(page.number + 1) else ""


def page_text(page) -> str:
    """Chữ theo thứ tự đọc; gộp khoảng trắng dàn trang cho gọn (đỡ tốn ngữ cảnh)."""
    text = unicodedata.normalize("NFC", page.get_text("text", sort=True))
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def ocr_path(pdf_path: str) -> str:
    """File ẩn cạnh PDF chứa chữ đã nhận dạng từ ảnh các trang quét: .<tên file>.ocr.json"""
    d, name = os.path.split(os.path.abspath(pdf_path))
    return os.path.join(d, f".{name}.ocr.json")


def load_ocr(pdf_path: str) -> dict:
    try:
        with open(ocr_path(pdf_path), encoding="utf-8") as f:
            pages = json.load(f).get("pages", {})
        return {int(k): str(v) for k, v in pages.items()}
    except (OSError, ValueError, AttributeError):
        return {}


def page_body(page, ocr: dict) -> tuple[str, bool]:
    """(chữ của trang, có phải chữ nhận dạng từ ảnh không)."""
    text = page_text(page)
    if not text and ocr.get(page.number + 1):
        return ocr[page.number + 1].strip(), True
    return text, False


def cmd_info(doc, _args) -> None:
    meta = {k: v for k, v in (doc.metadata or {}).items() if v and k in ("title", "author", "subject", "creationDate")}
    print(f"Số trang: {doc.page_count}")
    for k, v in meta.items():
        print(f"{k}: {v}")
    scanned = [p.number + 1 for p in doc if not p.get_text("text").strip()]
    if scanned:
        ocr = load_ocr(doc.name)
        todo = [n for n in scanned if n not in ocr]
        done = len(scanned) - len(todo)
        if todo:
            shown = ", ".join(map(str, todo[:30])) + (" …" if len(todo) > 30 else "")
            print(f"Trang không có lớp chữ (ảnh quét, cần render để xem): {shown}")
        if done:
            print(f"{done} trang ảnh quét đã có chữ nhận dạng (ocr-set), text/search đọc được.")
    toc = doc.get_toc(simple=True)
    if toc:
        print("\nMục lục (cấp · tiêu đề · trang):")
        for level, title, page in toc[:300]:
            print(f"{'  ' * (level - 1)}- {unicodedata.normalize('NFC', title).strip()} · trang {page}")
        if len(toc) > 300:
            print(f"… còn {len(toc) - 300} mục")
    else:
        print("\nPDF không có mục lục (bookmark). Có thể đọc vài trang đầu để tìm mục lục in trong sách.")


def cmd_text(doc, args) -> None:
    pages = parse_pages(args.pages, doc.page_count)
    ocr = load_ocr(doc.name)
    out, used = [], 0
    for n in pages:
        page = doc[n - 1]
        body, from_ocr = page_body(page, ocr)
        if from_ocr:
            body = "[Chữ nhận dạng từ ảnh trang quét]\n" + body
        body = body or "[Trang không có lớp chữ — có thể là ảnh quét; dùng lệnh render để xem]"
        chunk = f"=== Trang {n}{label(page)} ===\n{body}\n"
        if used + len(chunk) > MAX_TEXT and out:
            out.append(f"[Dừng ở trước trang {n} vì đã dài; đọc tiếp bằng --pages {n}-{pages[-1]}]")
            break
        out.append(chunk)
        used += len(chunk)
    print("\n".join(out) if out else "Không có trang nào trong phạm vi yêu cầu.")


def cmd_search(doc, args) -> None:
    query = unicodedata.normalize("NFC", args.query).casefold()
    hits = 0
    ocr = load_ocr(doc.name)
    for page in doc:
        text, _ = page_body(page, ocr)
        low = text.casefold()
        start = low.find(query)
        if start < 0:
            continue
        hits += 1
        count = low.count(query)
        a, b = max(0, start - 120), min(len(text), start + len(query) + 120)
        snippet = " ".join(text[a:b].split())
        print(f"- Trang {page.number + 1}{label(page)} ({count} lần): …{snippet}…")
        if hits >= 50:
            print("[Đã đủ 50 trang khớp, dừng tìm]")
            break
    if not hits:
        print(f"Không thấy “{args.query}” trong lớp chữ của PDF (trang ảnh quét không tìm được).")


def cmd_render(doc, args) -> None:
    if not args.out:
        fail("Cần --out <thư mục nháp> để lưu ảnh.")
    pages = parse_pages(args.pages, doc.page_count)
    if not args.pages:
        pages = pages[:1]
    if len(pages) > MAX_RENDER:
        print(f"Chỉ chụp {MAX_RENDER} trang đầu trong yêu cầu; chụp tiếp bằng lần gọi khác.")
        pages = pages[:MAX_RENDER]
    os.makedirs(args.out, exist_ok=True)
    base = os.path.splitext(os.path.basename(doc.name))[0][:40] or "pdf"
    zoom = args.dpi / 72
    for n in pages:
        pix = doc[n - 1].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        path = os.path.join(args.out, f"{base}-trang-{n}.png")
        pix.save(path)
        print(path)


def cmd_ocr_set(doc, args) -> None:
    pages = parse_pages(args.pages, doc.page_count) if args.pages else []
    if len(pages) != 1:
        fail("ocr-set cần đúng một trang: --pages N")
    if not args.text_file or not os.path.isfile(args.text_file):
        fail("Cần --text-file <file chữ UTF-8> chứa chữ đã đọc từ ảnh trang.")
    with open(args.text_file, encoding="utf-8") as f:
        text = unicodedata.normalize("NFC", f.read()).strip()
    if not text:
        fail("File chữ trống.")
    path = ocr_path(doc.name)
    data = {"version": 1, "pages": {str(k): v for k, v in load_ocr(doc.name).items()}}
    data["pages"][str(pages[0])] = text
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"Đã lưu chữ trang {pages[0]} ({len(text)} ký tự). Đã có chữ cho {len(data['pages'])} trang ảnh quét của file này.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Đọc PDF cho Claude")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("info", "text", "search", "render", "ocr-set"):
        p = sub.add_parser(name)
        p.add_argument("file")
        if name == "search":
            p.add_argument("query")
        if name in ("text", "render", "ocr-set"):
            p.add_argument("--pages")
        if name == "ocr-set":
            p.add_argument("--text-file")
        if name == "render":
            p.add_argument("--out")
            p.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args()
    doc = open_pdf(args.file)
    {"info": cmd_info, "text": cmd_text, "search": cmd_search, "render": cmd_render, "ocr-set": cmd_ocr_set}[args.cmd](doc, args)


if __name__ == "__main__":
    try:
        main()
    except ValueError as e:
        fail(f"Tham số không hợp lệ: {e}")
