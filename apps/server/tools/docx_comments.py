"""Nhận xét (comment) trong file Word cho VsScience — như người phản biện ghi bên lề.

  python docx_comments.py list <file.docx>
      Liệt kê nhận xét đang có (tác giả, đoạn được đánh dấu, nội dung).

  python docx_comments.py add <file.docx> --spec <nhan-xet.json> [--out <file.docx> | --in-place] [--author "Claude"]
      Thêm nhận xét gắn vào đúng đoạn chữ. Mặc định ghi ra bản sao "<tên> - nhận xét.docx" cạnh file gốc,
      file gốc giữ nguyên. nhan-xet.json là danh sách:
        [{"quote": "đoạn chữ có thật trong file", "comment": "nội dung nhận xét", "occurrence": 1}]
      "quote" chép đúng một đoạn ngắn (vài từ tới một câu) trong file; không phân biệt hoa thường và dấu
      cách thừa. "occurrence" (không bắt buộc): lần xuất hiện thứ mấy nếu đoạn đó lặp lại.
"""

import argparse
import copy
import json
import os
import re
import sys
import unicodedata

try:
    import docx
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph
    from docx.text.run import Run
except ImportError:
    print("LỖI: Máy chưa có thư viện python-docx.", file=sys.stderr)
    sys.exit(1)


def fail(msg: str) -> None:
    print(f"LỖI: {msg}", file=sys.stderr)
    sys.exit(1)


def norm_char(ch: str) -> str:
    """Một ký tự → dạng so sánh: chữ thường, khoảng trắng mọi loại thành dấu cách."""
    return " " if ch.isspace() else ch.lower()


def canon(s: str) -> str:
    s = unicodedata.normalize("NFC", s)
    return re.sub(r"\s+", " ", "".join(norm_char(c) for c in s)).strip()


def all_paragraphs(doc):
    """Mọi đoạn văn trong thân văn bản, kể cả trong bảng (theo thứ tự xuất hiện)."""
    for p in doc.element.body.iter(qn("w:p")):
        yield Paragraph(p, doc._body)


def simple_runs(par: Paragraph) -> list:
    """Các run có chữ của đoạn (chỉ run nằm trực tiếp trong đoạn hoặc trong hyperlink)."""
    out = []
    for r in par._p.iter(qn("w:r")):
        if r.getparent().tag in (qn("w:p"), qn("w:hyperlink")):
            out.append(Run(r, par))
    return out


def split_run(run: Run, at: int) -> Run:
    """Tách run tại vị trí `at` trong chữ của nó; trả về run sau (run trước giữ phần đầu).
    Chỉ tách run gồm một phần chữ <w:t> (thường gặp); run phức tạp thì trả lại chính nó."""
    ts = run._r.findall(qn("w:t"))
    others = [c for c in run._r if c.tag not in (qn("w:t"), qn("w:rPr"))]
    if len(ts) != 1 or others:
        return run
    text = ts[0].text or ""
    if at <= 0 or at >= len(text):
        return run
    new_r = copy.deepcopy(run._r)
    run._r.addnext(new_r)
    ts[0].text = text[:at]
    new_r.find(qn("w:t")).text = text[at:]
    for t in (ts[0], new_r.find(qn("w:t"))):
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return Run(new_r, run._parent)


def locate(par: Paragraph, quote_c: str, skip: int):
    """Tìm `quote_c` (đã canon) trong đoạn; trả về (danh sách run phủ đúng đoạn khớp, số lần khớp đã bỏ qua)."""
    runs = simple_runs(par)
    # Ghép chữ của các run, nhớ mỗi ký tự (đã canon, gộp khoảng trắng) thuộc run nào, vị trí nào.
    chars, owner = [], []
    prev_space = True
    for ri, r in enumerate(runs):
        for ci, ch in enumerate(unicodedata.normalize("NFC", r.text)):
            c = norm_char(ch)
            if c == " " and prev_space:
                continue
            chars.append(c)
            owner.append((ri, ci))
            prev_space = c == " "
    hay = "".join(chars)
    start = -1
    pos = 0
    while True:
        i = hay.find(quote_c, pos)
        if i < 0:
            return None, skip
        if skip == 0:
            start = i
            break
        skip -= 1
        pos = i + 1
    end = start + len(quote_c) - 1
    (r0, c0), (r1, c1) = owner[start], owner[end]
    first, last = runs[r0], runs[r1]
    # Tách để nhận xét gắn đúng phần chữ khớp (phần cuối tách trước để không lệch vị trí phần đầu).
    if r0 == r1:
        split_run(first, c1 + 1)
        mid = split_run(first, c0)
        return [mid, mid], 0
    split_run(last, c1 + 1)
    return [split_run(first, c0), last], 0


def cmd_list(args) -> None:
    doc = docx.Document(args.file)
    comments = list(doc.comments) if hasattr(doc, "comments") else []
    if not comments:
        print("File chưa có nhận xét nào.")
        return
    print(f"{len(comments)} nhận xét:")
    for c in comments:
        text = " ".join(p.text for p in c.paragraphs).strip()
        print(f"- [{c.author or 'không tên'}] {text}")


def cmd_add(args) -> None:
    try:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as e:  # noqa: BLE001
        fail(f"Không đọc được file nhận xét JSON: {e}")
    if not isinstance(spec, list) or not spec:
        fail("File nhận xét phải là danh sách [{\"quote\": …, \"comment\": …}].")
    doc = docx.Document(args.file)
    pars = list(all_paragraphs(doc))
    added, missing = 0, []
    for item in spec:
        quote, text = str(item.get("quote", "")).strip(), str(item.get("comment", "")).strip()
        if not quote or not text:
            missing.append((quote or "(trống)", "thiếu quote hoặc comment"))
            continue
        quote_c = canon(quote)
        skip = max(0, int(item.get("occurrence", 1)) - 1)
        found = None
        for par in pars:
            found, skip = locate(par, quote_c, skip)
            if found:
                break
        if not found:
            missing.append((quote, "không thấy trong file (chép đúng một đoạn ngắn nằm trong một đoạn văn)"))
            continue
        doc.add_comment(found, text=text, author=args.author, initials=args.author[:2].upper())
        added += 1
    if args.in_place:
        out = args.file
    else:
        stem, ext = os.path.splitext(args.file)
        out = args.out or f"{stem} - nhận xét{ext}"
    doc.save(out)
    print(f"Đã thêm {added}/{len(spec)} nhận xét → {out}")
    for q, why in missing:
        print(f"- Bỏ qua \"{q[:80]}\": {why}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Nhận xét trong file Word")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("file")
    p = sub.add_parser("add")
    p.add_argument("file")
    p.add_argument("--spec", required=True)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--out")
    g.add_argument("--in-place", action="store_true")
    p.add_argument("--author", default="Claude")
    args = ap.parse_args()
    if not os.path.isfile(args.file):
        fail(f"Không thấy file: {args.file}")
    if not args.file.lower().endswith(".docx"):
        fail("Chỉ làm được với file .docx (file .doc đời cũ: mở bằng Word và lưu lại thành .docx).")
    {"list": cmd_list, "add": cmd_add}[args.cmd](args)


if __name__ == "__main__":
    main()
