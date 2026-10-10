import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FindTarget } from '@ide/shared';
import { fold } from '../format';

/*
 * Tìm trong nội dung file đang xem (Ctrl+F), giống VS Code: không phân biệt hoa thường, không cần gõ dấu.
 * Chỗ khớp được tô bằng CSS Custom Highlight API nên không sửa DOM của khung xem (Word, PowerPoint…).
 */

// ---- Tô màu chỗ khớp: gộp của mọi khung xem vào hai highlight dùng chung ----

const owners = new Map<object, { all: Range[]; current: Range | null }>();

function repaint() {
  const reg = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !HighlightCtor) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const o of owners.values()) {
    all.push(...o.all);
    if (o.current) current.push(o.current);
  }
  reg.set('find-match', new HighlightCtor(...all));
  reg.set('find-current', new HighlightCtor(...current));
}

function setHighlights(owner: object, all: Range[], current: Range | null) {
  if (all.length === 0 && !current) owners.delete(owner);
  else owners.set(owner, { all, current });
  repaint();
}

/** Mọi chỗ khớp `query` trong phần chữ của `root` (bỏ qua chữ trong <style>, <script>). */
export function domMatches(root: Element, query: string): Range[] {
  const q = fold(query.trim().replace(/\s+/g, ' '));
  if (!q) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Bỏ chữ không hiển thị: style/script, nội dung nhận xét Word (hiện ở cột riêng).
    acceptNode: (n) =>
      n.parentElement?.closest('style,script,noscript,.docx-comment-popover') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  // Ghép chữ của mọi nút thành một chuỗi đã bỏ dấu, nhớ vị trí gốc của từng ký tự.
  let folded = '';
  const pos: { node: Text; offset: number }[] = [];
  let prevSpace = false;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const text = n.data;
    let i = 0;
    for (const ch of text) {
      // Khoảng trắng liên tiếp (xuống dòng trong HTML) tính như một dấu cách.
      const isSpace = /\s/.test(ch);
      if (isSpace && prevSpace) {
        i += ch.length;
        continue;
      }
      const f = isSpace ? ' ' : fold(ch);
      for (let k = 0; k < f.length; k++) pos.push({ node: n, offset: i });
      folded += f;
      prevSpace = isSpace;
      i += ch.length;
    }
  }
  const ranges: Range[] = [];
  for (let at = folded.indexOf(q); at >= 0 && ranges.length < 5000; at = folded.indexOf(q, at + q.length)) {
    const a = pos[at]!;
    const b = pos[at + q.length - 1]!;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, Math.min(b.node.length, b.offset + (b.node.data.codePointAt(b.offset)! > 0xffff ? 2 : 1)));
    ranges.push(r);
  }
  return ranges;
}

function scrollToRange(range: Range) {
  const el = range.startContainer.parentElement;
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

// ---- Ctrl+F: chuyển tới ô tìm của khung xem đang dùng ----

type FindHost = { root: HTMLElement; focus: () => void; usedAt: number };
const hosts = new Set<FindHost>();
let listening = false;

function onGlobalKey(e: KeyboardEvent) {
  if (!((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f')) return;
  const visible = [...hosts].filter((h) => h.root.offsetParent !== null);
  if (visible.length === 0) return;
  const active = document.activeElement;
  // Đang gõ trong ô chat (ngoài khung xem file): để trình duyệt xử lý như thường.
  const host =
    visible.find((h) => active && h.root.contains(active)) ?? visible.sort((a, b) => b.usedAt - a.usedAt)[0]!;
  e.preventDefault();
  host.focus();
}

function useFindHost(rootRef: RefObject<HTMLElement | null>, focus: () => void) {
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const host: FindHost = { root, focus: () => focusRef.current(), usedAt: Date.now() };
    const used = () => (host.usedAt = Date.now());
    root.addEventListener('pointerdown', used, true);
    root.addEventListener('focusin', used);
    hosts.add(host);
    if (!listening) {
      window.addEventListener('keydown', onGlobalKey);
      listening = true;
    }
    return () => {
      root.removeEventListener('pointerdown', used, true);
      root.removeEventListener('focusin', used);
      hosts.delete(host);
    };
  }, [rootRef]);
}

// ---- Thanh tìm ----

export type FindCount = { current: number; total: number } | null;

export function FindBar({
  rootRef,
  query,
  onQuery,
  count,
  onStep,
  placeholder = 'Tìm trong file',
  inputRef: externalRef,
}: {
  /** Phần tử bao khung xem: Ctrl+F khi đang dùng khung này sẽ vào ô tìm. */
  rootRef: RefObject<HTMLElement | null>;
  query: string;
  onQuery: (q: string) => void;
  count: FindCount;
  /** Sang chỗ khớp sau (1) hoặc trước (-1). */
  onStep: (dir: 1 | -1) => void;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? ownRef;
  useFindHost(rootRef, () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  });
  return (
    <span className="toolbar-group toolbar-search find-bar">
      <span className="codicon codicon-search" />
      <input
        ref={inputRef}
        className="search-input"
        placeholder={placeholder}
        title="Tìm trong file (Ctrl+F) · Enter: tiếp · Shift+Enter: trước"
        value={query}
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          }
          if (e.key === 'Escape') onQuery('');
        }}
      />
      {count && <span className="match-count">{count.total ? `${count.current}/${count.total}` : 'Không thấy'}</span>}
      <button className="icon-btn" title="Chỗ trước (Shift+Enter)" disabled={!count?.total} onClick={() => onStep(-1)}>
        <span className="codicon codicon-arrow-up" />
      </button>
      <button className="icon-btn" title="Chỗ tiếp (Enter)" disabled={!count?.total} onClick={() => onStep(1)}>
        <span className="codicon codicon-arrow-down" />
      </button>
    </span>
  );
}

/**
 * Tìm trong phần chữ đã dựng của khung xem (Word, PowerPoint, Markdown…). `version` đổi khi nội dung
 * được dựng lại (tải lại file, đổi cỡ) để tìm lại. `target`: mở từ kết quả tìm kiếm bên trái.
 */
export function useDomFind(containerRef: RefObject<HTMLElement | null>, version: unknown, target?: FindTarget) {
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const ownerRef = useRef({});
  /** Lần khớp cần nhảy tới sau khi tìm xong (từ target). */
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (!target) return;
    setQuery(target.query);
    pendingRef.current = target.occurrence ?? 0;
  }, [target?.nonce]);

  const lastQueryRef = useRef('');
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const t = window.setTimeout(() => {
      const found = query.trim() ? domMatches(root, query) : [];
      const queryChanged = lastQueryRef.current !== query;
      lastQueryRef.current = query;
      setRanges(found);
      const want = pendingRef.current;
      if (want !== null && found.length) {
        pendingRef.current = null;
        const i = Math.min(want, found.length - 1);
        setIndex(i);
        scrollToRange(found[i]!);
      } else if (queryChanged && found.length) {
        // Gõ từ khóa mới: tới chỗ khớp đầu tiên.
        setIndex(0);
        scrollToRange(found[0]!);
      } else {
        // Nội dung dựng lại (tải lại file…): giữ chỗ đang xem.
        setIndex((i) => (i < found.length ? i : 0));
      }
    }, 150);
    return () => window.clearTimeout(t);
  }, [query, version, containerRef, target?.nonce]);

  useEffect(() => {
    setHighlights(ownerRef.current, ranges, ranges[index] ?? null);
  }, [ranges, index]);

  useEffect(() => {
    const owner = ownerRef.current;
    return () => setHighlights(owner, [], null);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!ranges.length) return;
      const next = (index + dir + ranges.length) % ranges.length;
      setIndex(next);
      scrollToRange(ranges[next]!);
    },
    [ranges, index],
  );

  const count: FindCount = query.trim() ? { current: ranges.length ? index + 1 : 0, total: ranges.length } : null;
  return { query, setQuery, count, step };
}
