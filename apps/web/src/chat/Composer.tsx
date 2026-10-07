import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { TreeNode } from '@ide/shared';
import { useWorkspace } from '../api/workspace';
import { FILE_KIND_META, baseName } from '../fileTypes';
import { COMMANDS, findCommand, type Command, type CommandAction } from './commands';
import { ContextMeter } from './ContextMeter';
import { EFFORT_LABEL, MODELS, MODES, formatTokens, type Effort, type ModelInfo, type PermissionMode } from './models';

export type ComposerMenu = 'model' | 'mode' | null;

type MentionItem = { path: string; name: string; type: TreeNode['type']; kind?: TreeNode['kind'] };
type Popup = { kind: 'mention' | 'command'; query: string; start: number; active: number };

/** Bỏ dấu tiếng Việt để tìm "de thi" vẫn ra "Đề thi". */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

function flatten(node: TreeNode | undefined, out: MentionItem[] = []): MentionItem[] {
  for (const c of node?.children ?? []) {
    out.push({ path: c.id, name: c.name, type: c.type, kind: c.kind });
    if (c.type === 'folder') flatten(c, out);
  }
  return out;
}

/** Tìm "@..." hoặc "/..." ngay trước con trỏ để mở menu gợi ý. */
function detectTrigger(text: string, caret: number): Popup | null {
  const before = text.slice(0, caret);
  const cmd = /^\/([\w-]*)$/.exec(before);
  if (cmd) return { kind: 'command', query: cmd[1] ?? '', start: 0, active: 0 };
  const m = /(^|\s)@([^@\n]*)$/.exec(before);
  if (m) {
    const query = m[2] ?? '';
    return { kind: 'mention', query, start: before.length - query.length - 1, active: 0 };
  }
  return null;
}

export interface ComposerProps {
  activePath: string | null;
  model: ModelInfo;
  effort: Effort | null;
  mode: PermissionMode;
  usedTokens: number;
  /** Kích thước cửa sổ ngữ cảnh (từ Agent SDK nếu có, không thì theo bảng model). */
  contextTotal: number;
  connected: boolean;
  /** Claude đang làm việc: nút gửi thành nút dừng, Esc để dừng. */
  running: boolean;
  onStop: () => void;
  menu: ComposerMenu;
  /** Đổi `n` để điền `text` (nếu có) vào ô chat và focus. */
  insertRequest: { text: string; n: number } | null;
  onMenuChange: (m: ComposerMenu) => void;
  onModelChange: (id: string) => void;
  onEffortChange: (e: Effort) => void;
  onModeChange: (m: PermissionMode) => void;
  onRequireLogin: () => void;
  onCommand: (action: CommandAction) => void;
  onUnknownCommand: (name: string) => void;
  onSubmit: (text: string, files: string[]) => void;
}

export function Composer(props: ComposerProps) {
  const { activePath, model, effort, mode, usedTokens, connected, menu, onMenuChange } = props;
  const { tree } = useWorkspace();
  const [text, setText] = useState('');
  const [popup, setPopup] = useState<Popup | null>(null);
  const [includeActive, setIncludeActive] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupListRef = useRef<HTMLDivElement>(null);

  const allItems = useMemo(() => flatten(tree?.root), [tree]);

  useEffect(() => {
    if (!props.insertRequest) return;
    const value = props.insertRequest.text;
    if (value) setText(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = value ? value.length : el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [props.insertRequest]);

  // File đang mở đổi thì mặc định lại gửi kèm.
  useEffect(() => setIncludeActive(true), [activePath]);

  // Ô nhập tự giãn theo nội dung (tối đa ~10 dòng).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Đóng menu model/chế độ khi bấm ra ngoài.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.composer-menu, .menu-anchor')) onMenuChange(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu, onMenuChange]);

  // Mỗi "@" chỉ ứng với đường dẫn dài nhất khớp sau nó, để "@A/b.pdf" không bị tính thêm thư mục "A".
  const mentioned = useMemo(() => {
    const found = new Map<string, MentionItem>();
    for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
      let best: MentionItem | undefined;
      for (const item of allItems) {
        if (text.startsWith(item.path, i + 1) && (!best || item.path.length > best.path.length)) best = item;
      }
      if (best) found.set(best.path, best);
    }
    return [...found.values()];
  }, [allItems, text]);

  const popupItems = useMemo((): (MentionItem | Command)[] => {
    if (!popup) return [];
    const q = fold(popup.query);
    if (popup.kind === 'command') return COMMANDS.filter((c) => fold(c.name).includes(q));
    const scored = allItems
      .map((i) => ({ i, name: fold(i.name).indexOf(q), path: fold(i.path).indexOf(q) }))
      .filter((s) => s.name >= 0 || s.path >= 0)
      .sort((a, b) => (a.name < 0 ? 1 : 0) - (b.name < 0 ? 1 : 0) || a.i.path.length - b.i.path.length);
    return scored.slice(0, 50).map((s) => s.i);
  }, [popup, allItems]);

  // Giữ mục đang chọn trong tầm nhìn khi bấm mũi tên.
  useEffect(() => {
    popupListRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [popup?.active]);

  const focusAt = (pos: number) =>
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });

  const updateText = (value: string, caret: number) => {
    setText(value);
    const next = detectTrigger(value, caret);
    // Gõ "@tên có dấu cách" mà không còn khớp file nào thì thôi gợi ý.
    setPopup(next && !(next.kind === 'mention' && next.query.includes(' ') && !hasMatch(next.query)) ? next : null);
  };

  const hasMatch = (query: string) => {
    const q = fold(query);
    return allItems.some((i) => fold(i.path).includes(q));
  };

  const runCommand = (cmd: Command) => {
    if (cmd.kind === 'prompt') {
      setText(cmd.template);
      setPopup(null);
      focusAt(cmd.template.length);
      return;
    }
    setText('');
    setPopup(null);
    props.onCommand(cmd.action);
  };

  const choose = (item: MentionItem | Command) => {
    if (!popup) return;
    if (!('path' in item)) return runCommand(item);
    const mention = item;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const start = popup.start >= 0 ? popup.start : caret;
    const insert = `@${mention.path} `;
    const value = text.slice(0, start) + insert + text.slice(caret);
    setText(value);
    setPopup(null);
    focusAt(start + insert.length);
  };

  const removeMention = (path: string) => {
    const value = text.split(`@${path} `).join('').split(`@${path}`).join('');
    setText(value);
    focusAt(value.length);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      const name = trimmed.slice(1).split(/\s/)[0] ?? '';
      const cmd = findCommand(name);
      if (cmd) runCommand(cmd);
      else props.onUnknownCommand(name);
      if (!cmd) setText('');
      return;
    }
    const files = mentioned.map((m) => m.path);
    if (activePath && includeActive && !files.includes(activePath)) files.push(activePath);
    props.onSubmit(trimmed, files);
    setText('');
    setPopup(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Bộ gõ tiếng Việt (Telex/VNI) đang ghép chữ: không xử lý phím.
    if (e.nativeEvent.isComposing) return;
    if (popup && popupItems.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setPopup({ ...popup, active: (popup.active + delta + popupItems.length) % popupItems.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = popupItems[popup.active];
        if (item) choose(item);
        return;
      }
    }
    if (popup && e.key === 'Escape') {
      e.preventDefault();
      setPopup(null);
      return;
    }
    if (e.key === 'Escape' && props.running) {
      e.preventDefault();
      props.onStop();
      return;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === mode);
      props.onModeChange(MODES[(i + 1) % MODES.length]!.id);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  /** Mở menu gợi ý từ nút "+" (file) hoặc "/" (lệnh) mà không cần gõ ký tự. */
  const openPopupFromButton = (kind: Popup['kind']) => {
    onMenuChange(null);
    setPopup(popup?.kind === kind ? null : { kind, query: '', start: -1, active: 0 });
    inputRef.current?.focus();
  };

  const currentMode = MODES.find((m) => m.id === mode) ?? MODES[0]!;

  return (
    <div
      ref={rootRef}
      className={`composer ${connected ? '' : 'is-locked'}`}
      // Chưa kết nối Claude: bấm vào bất kỳ đâu trong ô chat sẽ mở cửa sổ đăng nhập.
      onMouseDownCapture={(e) => {
        if (connected) return;
        e.preventDefault();
        e.stopPropagation();
        props.onRequireLogin();
      }}
    >
      {popup && popupItems.length > 0 && (
        <div className="composer-popup" ref={popupListRef} role="listbox">
          <div className="popup-title">{popup.kind === 'mention' ? 'Nhắc tới file hoặc thư mục' : 'Lệnh'}</div>
          {popupItems.map((item, idx) => {
            const active = idx === popup.active;
            const key = 'path' in item ? item.path : item.name;
            const common = {
              className: `popup-item ${active ? 'is-active' : ''}`,
              onMouseEnter: () => setPopup({ ...popup, active: idx }),
              onMouseDown: (e: ReactMouseEvent) => {
                e.preventDefault();
                choose(item);
              },
            };
            if ('path' in item) {
              const icon =
                item.type === 'folder' ? 'codicon-folder kind-folder' : `${FILE_KIND_META[item.kind ?? 'pdf'].icon} kind-${item.kind}`;
              const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
              return (
                <div key={key} {...common} role="option" aria-selected={active}>
                  <span className={`codicon ${icon}`} />
                  <span className="popup-label">{item.name}</span>
                  <span className="popup-detail">{dir}</span>
                </div>
              );
            }
            return (
              <div key={key} {...common} role="option" aria-selected={active}>
                <span className={`codicon ${item.icon}`} />
                <span className="popup-label">/{item.name}</span>
                <span className="popup-detail">{item.description}</span>
              </div>
            );
          })}
        </div>
      )}

      {menu === 'model' && (
        <div className="composer-menu model-menu">
          <div className="popup-title">Model</div>
          {MODELS.map((m) => (
            <button key={m.id} className={`menu-row ${m.id === model.id ? 'is-active' : ''}`} onClick={() => props.onModelChange(m.id)}>
              <span className={`codicon ${m.id === model.id ? 'codicon-check' : 'codicon-blank'} menu-check`} />
              <span className="menu-label">{m.name}</span>
              <span className="menu-detail">
                {m.note} · {formatTokens(m.contextWindow)} ngữ cảnh
              </span>
            </button>
          ))}
          <div className="popup-title">Mức suy nghĩ</div>
          {model.efforts.length === 0 ? (
            <div className="menu-note">{model.name} không có tùy chọn mức suy nghĩ.</div>
          ) : (
            <div className="effort-row">
              {model.efforts.map((e) => (
                <button key={e} className={`effort-btn ${e === effort ? 'is-active' : ''}`} onClick={() => props.onEffortChange(e)}>
                  {EFFORT_LABEL[e]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {menu === 'mode' && (
        <div className="composer-menu mode-menu">
          <div className="popup-title">Chế độ (Shift+Tab để đổi nhanh)</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`menu-row ${m.id === mode ? 'is-active' : ''}`}
              onClick={() => {
                props.onModeChange(m.id);
                onMenuChange(null);
              }}
            >
              <span className={`codicon ${m.icon} menu-check`} />
              <span className="menu-label">{m.label}</span>
              <span className="menu-detail">{m.description}</span>
            </button>
          ))}
        </div>
      )}

      {mentioned.length > 0 && (
        <div className="composer-attachments">
          {mentioned.map((m) => (
            <span key={m.path} className="attachment" title={m.path}>
              <span className={`codicon ${m.type === 'folder' ? 'codicon-folder' : FILE_KIND_META[m.kind ?? 'pdf'].icon}`} />
              {m.name}
              <button className="attachment-remove" title="Bỏ" onClick={() => removeMention(m.path)}>
                <span className="codicon codicon-close" />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        placeholder={connected ? 'Nhắn cho Claude — @ để nhắc file, / để gọi lệnh' : 'Bấm để đăng nhập Claude…'}
        onChange={(e) => updateText(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          const t = e.currentTarget;
          if (popup) setPopup(detectTrigger(t.value, t.selectionStart));
        }}
        onBlur={() => setPopup(null)}
        aria-label="Nhắn cho Claude"
      />

      <div className="composer-toolbar">
        <button className="icon-btn" title="Đính kèm file (@)" onClick={() => openPopupFromButton('mention')}>
          <span className="codicon codicon-add" />
        </button>
        <button className="icon-btn slash-btn" title="Lệnh (/)" onClick={() => openPopupFromButton('command')}>
          /
        </button>
        <ContextMeter used={usedTokens} total={props.contextTotal} onClick={() => props.onCommand('context')} />
        <button
          className={`composer-chip menu-anchor ${menu === 'model' ? 'is-open' : ''}`}
          title="Đổi model"
          onClick={() => onMenuChange(menu === 'model' ? null : 'model')}
        >
          <span className="chip-strong">{model.name}</span>
          {effort && <span className="chip-dim">{EFFORT_LABEL[effort]}</span>}
        </button>
        {activePath && (
          <span className={`composer-chip active-file ${includeActive ? '' : 'is-excluded'}`} title={activePath}>
            <span className="codicon codicon-file" />
            <span className="active-file-name">{baseName(activePath)}</span>
            <button
              className="attachment-remove"
              title={includeActive ? 'Không gửi kèm file đang mở' : 'Gửi kèm file đang mở'}
              onClick={() => setIncludeActive((v) => !v)}
            >
              <span className={`codicon ${includeActive ? 'codicon-eye' : 'codicon-eye-closed'}`} />
            </button>
          </span>
        )}
        <span className="toolbar-spacer" />
        <button
          className={`composer-chip mode-chip menu-anchor mode-${mode} ${menu === 'mode' ? 'is-open' : ''}`}
          title={`${currentMode.label} — Shift+Tab để đổi`}
          onClick={() => onMenuChange(menu === 'mode' ? null : 'mode')}
        >
          <span className={`codicon ${currentMode.icon}`} />
          <span className="mode-label">{currentMode.short}</span>
        </button>
        {props.running && !text.trim() ? (
          <button className="send-btn is-stop" title="Dừng (Esc)" onClick={props.onStop}>
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button className="send-btn" title="Gửi (Enter)" disabled={!text.trim()} onClick={submit}>
            <span className="codicon codicon-arrow-up" />
          </button>
        )}
      </div>
    </div>
  );
}
