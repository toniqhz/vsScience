"""Tài liệu tham khảo cho VsScience (thư viện .bib / .ris của thư mục, ví dụ xuất từ Zotero).

  python cite.py list   <thu-vien.bib|.ris>                       các mục: khóa, tác giả, năm, tên
  python cite.py format <thu-vien> [--style apa|vancouver] [--keys k1,k2]
                                                                   danh mục tài liệu tham khảo đã định dạng
  python cite.py check  <thu-vien>                                 mục thiếu thông tin (tác giả, năm, DOI…), khóa trùng
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vs_refs  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Tài liệu tham khảo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("list", "format", "check"):
        p = sub.add_parser(name)
        p.add_argument("library")
        if name == "format":
            p.add_argument("--style", choices=vs_refs.STYLES, default="apa")
            p.add_argument("--keys", default="")
    args = ap.parse_args()
    if not os.path.isfile(args.library):
        print(f"LỖI: Không thấy file: {args.library}", file=sys.stderr)
        sys.exit(1)
    entries = vs_refs.load(args.library)
    if not entries:
        print("Thư viện chưa có mục nào (hoặc không đọc được định dạng).")
        return
    if args.cmd == "list":
        print(f"{len(entries)} mục:")
        for e in entries:
            authors = vs_refs.split_authors(e.get("author", ""))
            who = authors[0] + (" và cs." if len(authors) > 1 else "") if authors else "?"
            print(f"- {e['key']}: {who} ({e.get('year', '?')}). {e.get('title', '')}")
    elif args.cmd == "format":
        keys = [k.strip() for k in args.keys.split(",") if k.strip()]
        by_key = {e["key"]: e for e in entries}
        chosen = [by_key[k] for k in keys if k in by_key] if keys else entries
        missing = [k for k in keys if k not in by_key]
        if args.style == "apa":
            chosen = vs_refs.sort_apa(chosen)
        for i, e in enumerate(chosen, 1):
            text = vs_refs.plain(vs_refs.format_entry(e, args.style))
            print(f"{i}. {text}" if args.style == "vancouver" else text)
        for k in missing:
            print(f"[Không có khóa '{k}' trong thư viện]")
    else:
        seen, bad = set(), 0
        for e in entries:
            miss = vs_refs.problems(e)
            if e["key"] in seen:
                miss.append("khóa trùng")
            seen.add(e["key"])
            if miss:
                bad += 1
                print(f"- {e['key']}: thiếu {', '.join(miss)}")
        print(f"{len(entries) - bad}/{len(entries)} mục đủ thông tin.")


if __name__ == "__main__":
    main()
