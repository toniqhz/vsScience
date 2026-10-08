import { useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileChange } from '@ide/shared';
import { baseName } from '../fileTypes';
import type { Item, LocalNode } from './agentStore';
import { COMMANDS } from './commands';
import { ContextCard } from './ContextMeter';
import { derivePlan, PLAN_TOOLS, type PlanStep } from './plan';
import { stepIcon } from './PlanPanel';

const KIND_ICON: Record<string, string> = {
  pdf: 'codicon-file-pdf kind-pdf',
  docx: 'codicon-file-text kind-word',
  doc: 'codicon-file-text kind-word',
  xlsx: 'codicon-table kind-excel',
  xlsm: 'codicon-table kind-excel',
  xls: 'codicon-table kind-excel',
  csv: 'codicon-table kind-excel',
};

function fileIcon(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return KIND_ICON[ext] ?? 'codicon-file';
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Claude đôi khi trả tiếng Việt ở dạng dấu tổ hợp (NFD); font monospace hiển thị
 * tách dấu, nên chuẩn hóa về dạng dựng sẵn (NFC) trước khi hiện.
 */
const nfc = (s: string) => s.normalize('NFC');

/** Bỏ thẻ <tool_use_error> trong thông báo lỗi của công cụ. */
const cleanError = (s: string) => s.replace(/<\/?tool_use_error>/g, '').trim();

/** Câu trả lời của Claude: markdown, link mở trong tab mới. */
const AGENT_LABELS: Record<string, string> = { reviewer: 'phản biện', Explore: 'tìm kiếm', Plan: 'lập kế hoạch' };

/** Tên thân thiện của subagent. */
export function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? name;
}

/** Đang trả lời: chỉ hiện các dòng đã viết xong, dòng đang viết dở hiện khi xuống dòng (không kiểu gõ từng chữ). */
function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf('\n') + 1);
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  if (streaming) text = completeLines(text);
  return (
    <div className="msg-assistant">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
      >
        {nfc(text)}
      </Markdown>
    </div>
  );
}

/** Dòng thao tác thu gọn, bấm để xem chi tiết (giống Claude Code trong VS Code). */
function ToolRow({
  icon,
  title,
  detail,
  pending,
  isError,
  children,
}: {
  icon: string;
  title: string;
  detail?: string;
  pending: boolean;
  isError?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = !!children;
  return (
    <div className={`tool-row ${isError ? 'is-error' : ''}`}>
      <button className="tool-row-head" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className={`codicon ${pending ? 'codicon-loading codicon-modifier-spin' : isError ? 'codicon-error' : icon} tool-icon`} />
        <span className="tool-title">{title}</span>
        {detail && <span className="tool-detail">{detail}</span>}
        {expandable && <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} tool-chevron`} />}
      </button>
      {open && children && <div className="tool-body">{children}</div>}
    </div>
  );
}

/** Diff theo kiểu VS Code: dòng thêm xanh, dòng bỏ đỏ, số dòng bên trái. */
export function DiffView({ change }: { change: FileChange }) {
  return (
    <div className="diff-view">
      {change.hunks.map((h, hi) => {
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        return (
          <div key={hi} className="diff-hunk">
            {hi > 0 && <div className="diff-sep">⋯</div>}
            {h.lines
              .filter((l) => !l.startsWith('\\'))
              .map((l, li) => {
                const sign = l[0];
                const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
                const no = sign === '+' ? newNo++ : sign === '-' ? oldNo++ : (oldNo++, newNo++);
                return (
                  <div key={li} className={`diff-line diff-${cls}`}>
                    <span className="diff-no">{h.oldStart > 0 || h.newStart > 0 ? no : ''}</span>
                    <span className="diff-sign">{sign === '+' || sign === '-' ? sign : ' '}</span>
                    <span className="diff-text">{nfc(l.slice(1)) || ' '}</span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function ChangeStats({ change }: { change: Pick<FileChange, 'additions' | 'deletions' | 'kind'> }) {
  return (
    <span className="change-stats">
      {change.kind === 'create' && <span className="change-badge">Mới</span>}
      <span className="stat-add">+{change.additions}</span>
      <span className="stat-del">−{change.deletions}</span>
    </span>
  );
}

/** Thẻ thay đổi file: tên file, số dòng thêm/bớt; mặc định thu gọn, mở ra xem diff. */
function FileChangeCard({
  path,
  change,
  pending,
  isError,
  errorText,
  onOpenFile,
}: {
  path: string;
  change?: FileChange;
  pending: boolean;
  isError: boolean;
  errorText?: string;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Lần sửa không áp dụng được (Claude thường tự thử lại): hiện nhẹ, chi tiết kỹ thuật ẩn trong phần mở rộng.
  const expandable = !!change || (isError && !!errorText);
  return (
    <div className={`file-change ${isError ? 'is-error' : ''}`}>
      <div className="file-change-head">
        <button className="file-change-toggle" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable} title={expandable ? 'Xem chi tiết' : undefined}>
          <span className={`codicon ${expandable ? (open ? 'codicon-chevron-down' : 'codicon-chevron-right') : 'codicon-blank'}`} />
          <span className={`codicon ${fileIcon(path)}`} />
        </button>
        <button className="file-change-name" onClick={() => onOpenFile(path)} title={`Mở ${path}`}>
          {baseName(path)}
        </button>
        <span className="file-change-dir">{dirName(path)}</span>
        <span className="file-change-right">
          {pending && <span className="codicon codicon-loading codicon-modifier-spin" />}
          {isError && <span className="file-change-error">Không áp dụng được</span>}
          {change && !isError && <ChangeStats change={change} />}
        </span>
      </div>
      {open && isError && errorText && <div className="file-change-errtext">{nfc(cleanError(errorText))}</div>}
      {open && change && !isError && <DiffView change={change} />}
    </div>
  );
}

/** Lệnh gọi công cụ đọc PDF của app (python ".../pdf.py" text "file.pdf" --pages 3-7). */
function pdfToolCall(command: string): { sub: string; file: string; pages?: string; query?: string } | null {
  const m = /^\s*(?:&\s*)?\S*python[\d.]*(?:\.exe)?["']?\s+["']?[^"'\s]*?[^"']*pdf\.py["']?\s+(info|text|search|render)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(.*)$/i.exec(command);
  if (!m) return null;
  const rest = m[5] ?? '';
  const q = /^\s*(?:"([^"]+)"|'([^']+)'|([^-\s]\S*))/.exec(rest);
  return {
    sub: m[1]!.toLowerCase(),
    file: m[2] ?? m[3] ?? m[4] ?? '',
    pages: /--pages\s+(\S+)/.exec(rest)?.[1]?.replace(/["']/g, ''),
    query: m[1] === 'search' ? q?.slice(1).find(Boolean) : undefined,
  };
}

type ToolEntry = Extract<Item, { type: 'tool' }>;

/** Dòng ngắn trong hội thoại khi Claude lập hoặc cập nhật kế hoạch (bảng đầy đủ ghim ở đầu khung chat). */
type Todo = { content?: string; status?: string };

/** Tóm tắt một lần TodoWrite (mỗi lần ghi là cả danh sách) bằng phần khác so với lần trước. */
function todoChanges(prev: Todo[] | null, next: Todo[]): string {
  if (!prev) return `Lập kế hoạch ${next.length} bước`;
  const parts: string[] = [];
  next.forEach((t, i) => {
    const before = prev.find((p) => p.content === t.content);
    if (!before) parts.push(`thêm bước ${i + 1}`);
    else if (before.status !== t.status)
      parts.push(`${t.status === 'completed' ? 'xong' : t.status === 'in_progress' ? 'bắt đầu' : 'mở lại'} bước ${i + 1}`);
  });
  const removed = prev.filter((p) => !next.some((t) => t.content === p.content)).length;
  if (removed) parts.push(`bỏ ${removed} bước`);
  if (!parts.length) return 'Cập nhật kế hoạch';
  const text = parts.join(' · ');
  return text[0]!.toUpperCase() + text.slice(1);
}

function PlanNote({ entries, steps, prevTodos }: { entries: ToolEntry[]; steps: Map<string, PlanStep>; prevTodos: Todo[] | null }) {
  const first = entries[0]!;
  const keys = entries.map((e) => e.key).join(' ');
  if (first.name === 'TodoWrite') {
    const todos = first.input.todos as Todo[];
    const current = todos.find((t) => t.status === 'in_progress');
    return (
      <div className="plan-note" data-keys={keys}>
        <span className="codicon codicon-checklist" />
        <span>
          {todoChanges(prevTodos, todos)}
          {current?.content && <span className="plan-note-detail"> · đang làm: {current.content}</span>}
        </span>
      </div>
    );
  }
  if (first.name === 'TaskCreate') {
    const subjects = entries.map((e) => str(e.input.subject)).filter(Boolean);
    return (
      <div className="plan-note" data-keys={keys}>
        <span className="codicon codicon-checklist" />
        <span>
          {subjects.length === 1 ? 'Thêm bước vào kế hoạch: ' : `Lập kế hoạch ${subjects.length} bước: `}
          <span className="plan-note-detail">{subjects.join(' · ')}</span>
        </span>
      </div>
    );
  }
  const id = str(first.input.taskId).replace(/^#/, '');
  const status = str(first.input.status);
  const step = steps.get(id);
  const n = step ? [...steps.keys()].indexOf(id) + 1 : null;
  const label =
    status === 'completed' ? 'Xong bước' : status === 'in_progress' ? 'Bắt đầu bước' : status === 'deleted' ? 'Bỏ bước' : status === 'pending' ? 'Mở lại bước' : 'Sửa bước';
  return (
    <div className={`plan-note is-${status || 'edit'}`} data-keys={keys}>
      <span className={`codicon ${status === 'deleted' ? 'codicon-trash' : stepIcon((status || 'pending') as PlanStep['status'])}`} />
      <span>
        {label}
        {n ? ` ${n}` : ''}
        {(step?.subject ?? str(first.input.subject)) && <span className="plan-note-detail">: {step?.subject ?? str(first.input.subject)}</span>}
      </span>
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return <pre className="tool-pre">{nfc(children)}</pre>;
}

/** Hiển thị một lần dùng công cụ theo loại. Bash và đầu ra mặc định ẩn, mở ra mới thấy. */
function ToolItem({ item, running, onOpenFile }: { item: Extract<Item, { type: 'tool' }>; running: boolean; onOpenFile: (p: string) => void }) {
  const { name, input, result } = item;
  const pending = !result && running;
  const isError = !!result?.isError;
  const output = result?.output ?? '';

  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const path = result?.fileChange?.path ?? str(input.file_path ?? input.notebook_path);
    return (
      <FileChangeCard
        path={path}
        change={result?.fileChange}
        pending={pending}
        isError={isError}
        errorText={isError ? output : undefined}
        onOpenFile={onOpenFile}
      />
    );
  }
  if (PLAN_TOOLS.has(name)) return null;

  const outputBody = output ? <Pre>{output}</Pre> : undefined;
  switch (name) {
    case 'Read': {
      const pages = str(input.pages);
      return <ToolRow icon="codicon-eye" title="Đọc" detail={`${baseName(str(input.file_path))}${pages ? ` · trang ${pages}` : ''}`} pending={pending} isError={isError} />;
    }
    case 'Grep':
      return <ToolRow icon="codicon-search" title="Tìm" detail={`“${str(input.pattern)}”`} pending={pending} isError={isError}>{outputBody}</ToolRow>;
    case 'Glob':
      return <ToolRow icon="codicon-search" title="Tìm file" detail={str(input.pattern)} pending={pending} isError={isError}>{outputBody}</ToolRow>;
    case 'Bash':
    case 'PowerShell': {
      const pdf = pdfToolCall(str(input.command));
      if (pdf) {
        const name = pdf.file.split(/[\\/]/).pop() ?? pdf.file;
        const pages = pdf.pages ? ` · trang ${pdf.pages.replace(/-/g, '–')}` : '';
        const [icon, title, detail] =
          pdf.sub === 'info'
            ? ['codicon-list-tree', 'Xem mục lục PDF', name]
            : pdf.sub === 'search'
              ? ['codicon-search', 'Tìm trong PDF', `“${pdf.query ?? ''}” · ${name}`]
              : pdf.sub === 'render'
                ? ['codicon-file-media', 'Xem trang PDF dạng ảnh', `${name}${pages}`]
                : ['codicon-eye', 'Đọc PDF', `${name}${pages}`];
        return (
          <ToolRow icon={icon} title={title} detail={detail} pending={pending} isError={isError}>
            {outputBody}
          </ToolRow>
        );
      }
      return (
        <ToolRow icon="codicon-terminal" title="Chạy lệnh" detail={str(input.description)} pending={pending} isError={isError}>
          <Pre>{`$ ${str(input.command)}${output ? `\n\n${output}` : ''}`}</Pre>
        </ToolRow>
      );
    }
    case 'WebSearch':
      return <ToolRow icon="codicon-globe" title="Tìm trên web" detail={str(input.query)} pending={pending} isError={isError}>{outputBody}</ToolRow>;
    case 'WebFetch':
      return <ToolRow icon="codicon-link" title="Đọc trang web" detail={str(input.url)} pending={pending} isError={isError}>{outputBody}</ToolRow>;
    case 'Task':
    case 'Agent': {
      const agent = str(input.subagent_type);
      const isReviewer = agent === 'reviewer';
      return (
        <ToolRow
          icon={isReviewer ? 'codicon-checklist' : 'codicon-hubot'}
          title={isReviewer ? 'Phản biện độc lập' : agent && agent !== 'general-purpose' ? `Trợ lý ${agentLabel(agent)}` : 'Giao việc cho trợ lý phụ'}
          detail={str(input.description)}
          pending={pending}
          isError={isError}
        >
          {/* Báo cáo của trợ lý phụ là Markdown (danh sách vấn đề, mức độ…). */}
          {output ? <AssistantText text={output} streaming={false} /> : undefined}
        </ToolRow>
      );
    }
    case 'Artifact': {
      const action = str(input.action) || 'publish';
      if (action !== 'publish') return <ToolRow icon="codicon-preview" title="Xem artifact" detail={action} pending={pending} isError={isError}>{outputBody}</ToolRow>;
      const file = str(input.file_path).split(/[\\/]/).pop() ?? '';
      return (
        <ToolRow icon="codicon-preview" title="Tạo artifact" detail={`${str(input.title) || file} · xem ở mục Artifact bên trái`} pending={pending} isError={isError}>
          {outputBody}
        </ToolRow>
      );
    }
    case 'Skill':
      return <ToolRow icon="codicon-sparkle" title="Dùng kỹ năng" detail={str(input.skill ?? input.command)} pending={pending} isError={isError}>{outputBody}</ToolRow>;
    case 'ExitPlanMode':
      return null;
    default:
      return <ToolRow icon="codicon-tools" title={name} pending={pending} isError={isError}>{outputBody}</ToolRow>;
  }
}

function PermissionCard({
  item,
  onAnswer,
}: {
  item: Extract<Item, { type: 'permission' }>;
  onAnswer: (id: string, allow: boolean, always: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { toolName, input, fileChange, allowed, outside } = item;
  const path = fileChange?.path ?? str(input.file_path);
  const isFile = toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit';

  let title: ReactNode;
  let body: ReactNode = null;
  if (isFile) {
    title = (
      <>
        Claude muốn {fileChange?.kind === 'create' ? 'tạo' : 'sửa'} file <strong>{baseName(path)}</strong>
      </>
    );
    if (fileChange) body = open ? <DiffView change={fileChange} /> : null;
  } else if (toolName === 'Bash' || toolName === 'PowerShell') {
    title = <>Claude muốn chạy một lệnh trên máy{input.description ? <>: <strong>{str(input.description)}</strong></> : null}</>;
    body = open ? <Pre>{str(input.command)}</Pre> : null;
  } else if (toolName === 'ExitPlanMode') {
    title = <>Claude đề xuất kế hoạch</>;
    body = (
      <div className="msg-assistant">
        <Markdown remarkPlugins={[remarkGfm]}>{str(input.plan)}</Markdown>
      </div>
    );
  } else {
    title = <>Claude muốn dùng công cụ <strong>{toolName}</strong></>;
    body = open ? <Pre>{JSON.stringify(input, null, 2)}</Pre> : null;
  }
  const canExpand = toolName !== 'ExitPlanMode' && (isFile ? !!fileChange : true);

  if (allowed !== undefined) {
    return (
      <div className={`permission-done ${allowed ? 'is-allowed' : 'is-denied'}`}>
        <span className={`codicon ${allowed ? 'codicon-check' : 'codicon-close'}`} /> {title} — {allowed ? 'đã cho phép' : 'đã từ chối'}
      </div>
    );
  }
  return (
    <div className="permission-card">
      <div className="permission-title">
        <span className="codicon codicon-shield" />
        <span>{title}</span>
        {fileChange && <ChangeStats change={fileChange} />}
      </div>
      {canExpand && (
        <button className="link-btn permission-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Ẩn chi tiết' : isFile ? 'Xem thay đổi' : 'Xem chi tiết'}
        </button>
      )}
      {outside && outside.length > 0 && (
        <div className="permission-outside">
          <span className="codicon codicon-warning" />
          <div>
            Cần bạn cho phép vì thao tác này đụng tới ngoài thư mục đang mở:
            <ul>
              {outside.slice(0, 5).map((p) => (
                <li key={p}>{nfc(p)}</li>
              ))}
              {outside.length > 5 && <li>… và {outside.length - 5} đường dẫn khác</li>}
            </ul>
          </div>
        </div>
      )}
      {body}
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onAnswer(item.id, true, false)}>
          {toolName === 'ExitPlanMode' ? 'Đồng ý, bắt đầu làm' : 'Cho phép'}
        </button>
        {isFile && (
          <button className="btn" onClick={() => onAnswer(item.id, true, true)}>
            Cho phép mọi lần sửa trong phiên này
          </button>
        )}
        <button className="btn" onClick={() => onAnswer(item.id, false, false)}>
          {toolName === 'ExitPlanMode' ? 'Chưa, sửa kế hoạch' : 'Từ chối'}
        </button>
      </div>
    </div>
  );
}

/** Tổng kết cuối lượt: danh sách file đã thay đổi (giống phần "files changed" của VS Code). */
function ResultItem({ item, onOpenFile }: { item: Extract<Item, { type: 'result' }>; onOpenFile: (p: string) => void }) {
  if (item.interrupted) {
    return (
      <>
        {item.changes.length > 0 && <ResultItem item={{ ...item, interrupted: false }} onOpenFile={onOpenFile} />}
        <div className="msg-notice">
          <span className="codicon codicon-debug-stop" />
          Đã dừng theo yêu cầu.
        </div>
      </>
    );
  }
  if (item.isError) {
    return (
      <div className="msg-notice tone-warn">
        <span className="codicon codicon-warning" />
        {item.message ?? 'Lượt làm việc bị lỗi.'}
      </div>
    );
  }
  if (item.changes.length === 0) return null;
  const add = item.changes.reduce((n, c) => n + c.additions, 0);
  const del = item.changes.reduce((n, c) => n + c.deletions, 0);
  return (
    <div className="changes-summary">
      <div className="changes-summary-head">
        <span className="codicon codicon-diff" />
        Đã thay đổi {item.changes.length} file
        <span className="change-stats">
          <span className="stat-add">+{add}</span>
          <span className="stat-del">−{del}</span>
        </span>
      </div>
      {item.changes.map((c) => (
        <button key={c.path} className="changes-summary-row" onClick={() => onOpenFile(c.path)} title={`Mở ${c.path}`}>
          <span className={`codicon ${fileIcon(c.path)}`} />
          <span className="file-change-name">{baseName(c.path)}</span>
          <span className="file-change-dir">{dirName(c.path)}</span>
          <ChangeStats change={c} />
        </button>
      ))}
    </div>
  );
}

function LocalItem({ node }: { node: LocalNode }) {
  switch (node.kind) {
    case 'notice':
      return (
        <div className={`msg-notice tone-${node.tone}`}>
          <span className={`codicon ${node.tone === 'warn' ? 'codicon-warning' : 'codicon-info'}`} />
          {node.text}
        </div>
      );
    case 'context':
      return <ContextCard usage={node.usage} modelName={node.modelName} fallbackMax={node.fallbackMax} />;
    case 'help':
      return (
        <div className="help-card">
          <strong>Lệnh</strong>
          <ul>
            {COMMANDS.map((c) => (
              <li key={c.name}>
                <code>/{c.name}</code> {c.description}
              </li>
            ))}
          </ul>
          <strong>Phím tắt</strong>
          <ul>
            <li>
              <kbd>Enter</kbd> gửi · <kbd>Shift+Enter</kbd> xuống dòng · <kbd>Esc</kbd> dừng Claude
            </li>
            <li>
              <kbd>@</kbd> nhắc tới file · <kbd>/</kbd> gọi lệnh
            </li>
            <li>
              <kbd>Shift+Tab</kbd> đổi chế độ (hỏi trước / tự động / lập kế hoạch)
            </li>
          </ul>
        </div>
      );
  }
}

type UserItem = Extract<Item, { type: 'user' }>;

/**
 * Câu hỏi của người dùng, ghim ở đầu khung khi cuộn qua phần trả lời của nó (như Claude Code trong VS Code).
 * Đang ghim thì thu còn 2 dòng; bấm vào để cuộn về đầu lượt.
 */
function StickyUser({ item: it }: { item: UserItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const root = el?.closest('.chat-scroll');
    const turn = el?.parentElement;
    if (!el || !root || !turn) return;
    // Đang ghim: lượt này đã bắt đầu phía trên đỉnh khung, còn câu hỏi đang nằm sát đỉnh.
    const check = () => {
      const top = root.getBoundingClientRect().top;
      const r = el.getBoundingClientRect();
      setStuck(turn.getBoundingClientRect().top < top - 2 && r.top <= top + 1 && r.bottom > top);
    };
    check();
    root.addEventListener('scroll', check, { passive: true });
    return () => root.removeEventListener('scroll', check);
  }, []);
  return (
    <div ref={ref} className={`msg-user-sticky ${stuck ? 'is-stuck' : ''}`}>
      <div
        className="msg-user"
        title={stuck ? 'Về đầu câu hỏi này' : undefined}
        onClick={() => stuck && ref.current?.parentElement?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
      >
        <div className="msg-user-text">{it.text}</div>
        {it.files.length > 0 && (
          <div className="msg-files">
            {it.files.map((f) => (
              <span key={f} className="attachment" title={f}>
                <span className={`codicon ${fileIcon(f)}`} />
                {baseName(f)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mục không hiển thị gì (công cụ ghi kế hoạch đã gộp vào dòng khác, kết quả lượt không đổi file…). */
function isHidden(it: Item): boolean {
  if (it.type === 'tool') return PLAN_TOOLS.has(it.name) || it.name === 'ExitPlanMode';
  if (it.type === 'result') return !it.interrupted && !it.isError && it.changes.length === 0;
  // Câu trả lời mới bắt đầu, chưa xong dòng nào: chưa hiện (vẫn có dòng "Claude đang làm việc…").
  if (it.type === 'text') return it.streaming && !completeLines(it.text).trim();
  return false;
}

/** Màu chấm trên đường timeline bên trái (như Claude Code trong VS Code). */
type Dot = 'text' | 'ok' | 'error' | 'pending' | 'ask' | 'muted';

function dotOf(it: Item | ToolEntry[], running: boolean): Dot {
  if (Array.isArray(it)) return 'ok';
  switch (it.type) {
    case 'text':
      return 'text';
    case 'tool':
      return it.result ? (it.result.isError ? 'error' : 'ok') : running ? 'pending' : 'muted';
    case 'permission':
      return it.allowed === undefined ? 'ask' : it.allowed ? 'ok' : 'error';
    case 'result':
      return it.isError ? 'error' : it.interrupted ? 'muted' : 'ok';
    case 'error':
      return 'error';
    default:
      return 'muted';
  }
}

export function Transcript({
  items,
  running,
  onOpenFile,
  onPermission,
}: {
  items: Item[];
  running: boolean;
  onOpenFile: (path: string) => void;
  onPermission: (id: string, allow: boolean, always: boolean) => void;
}) {
  const waitingPermission = items.some((it) => it.type === 'permission' && it.allowed === undefined);
  const steps = new Map(derivePlan(items).map((st) => [st.id, st]));
  // Các bước Claude tạo liền nhau gộp thành một dòng "Lập kế hoạch N bước".
  const units: (Item | ToolEntry[])[] = [];
  const prevTodos = new Map<string, Todo[] | null>();
  let lastTodos: Todo[] | null = null;
  for (const it of items) {
    if (it.type === 'tool' && it.name === 'TodoWrite' && Array.isArray(it.input.todos)) {
      prevTodos.set(it.key, lastTodos);
      lastTodos = it.input.todos as Todo[];
      units.push([it]);
    } else if (it.type === 'tool' && (it.name === 'TaskCreate' || it.name === 'TaskUpdate')) {
      const last = units[units.length - 1];
      if (it.name === 'TaskCreate' && Array.isArray(last) && last[0]!.name === 'TaskCreate') last.push(it);
      else units.push([it]);
    } else if (!isHidden(it)) units.push(it);
  }
  // Chia theo lượt: mỗi câu hỏi cùng phần trả lời của nó (để câu hỏi ghim được trong phạm vi lượt đó).
  const turns: { key: string; user?: UserItem; units: (Exclude<Item, UserItem> | ToolEntry[])[] }[] = [];
  for (const u of units) {
    if (!Array.isArray(u) && u.type === 'user') turns.push({ key: u.key, user: u, units: [] });
    else {
      if (turns.length === 0) turns.push({ key: 'dau', units: [] });
      turns[turns.length - 1]!.units.push(u);
    }
  }
  if (turns.length === 0 && running) turns.push({ key: 'dau', units: [] });
  return (
    <div className="chat-column transcript">
      {turns.map((t, i) => (
        <div key={t.key} className="turn">
          {t.user && <StickyUser item={t.user} />}
          {t.units.map((it) => (
            // Mọi thứ Claude làm nằm trên đường timeline bên trái.
            <div key={Array.isArray(it) ? it[0]!.key : it.key} className={`tl-item dot-${dotOf(it, running)}`}>
              {renderUnit(it)}
            </div>
          ))}
          {i === turns.length - 1 && running && !waitingPermission && (
            <div className="tl-item dot-pending">
              <div className="working">Claude đang làm việc…</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  function renderUnit(it: Exclude<Item, UserItem> | ToolEntry[]): ReactNode {
    if (Array.isArray(it)) return <PlanNote entries={it} steps={steps} prevTodos={prevTodos.get(it[0]!.key) ?? null} />;
    switch (it.type) {
      case 'text':
        return <AssistantText text={it.text} streaming={it.streaming} />;
      case 'tool':
        return <ToolItem item={it} running={running} onOpenFile={onOpenFile} />;
      case 'permission':
        return <PermissionCard item={it} onAnswer={onPermission} />;
      case 'result':
        return <ResultItem item={it} onOpenFile={onOpenFile} />;
      case 'error':
        return (
          <div className="msg-notice tone-warn">
            <span className="codicon codicon-warning" />
            {it.message}
          </div>
        );
      case 'local':
        return <LocalItem node={it.node} />;
    }
  }
}
