import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileChange } from '@ide/shared';
import { baseName } from '../fileTypes';
import type { Item, LocalNode } from './agentStore';
import { COMMANDS } from './commands';
import { ContextCard } from './ContextMeter';

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

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={`msg-assistant ${streaming ? 'is-streaming' : ''}`}>
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

function TodoList({ todos }: { todos: { content?: string; status?: string; activeForm?: string }[] }) {
  return (
    <div className="todo-list">
      <div className="todo-title">
        <span className="codicon codicon-checklist" /> Việc cần làm
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`todo-item todo-${t.status}`}>
          <span
            className={`codicon ${t.status === 'completed' ? 'codicon-pass' : t.status === 'in_progress' ? 'codicon-circle-filled' : 'codicon-circle-large-outline'}`}
          />
          <span>{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
        </div>
      ))}
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
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return <TodoList todos={input.todos as never} />;

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
      return (
        <ToolRow icon="codicon-terminal" title="Chạy lệnh" detail={str(input.description)} pending={pending} isError={isError}>
          <Pre>{`$ ${str(input.command)}${output ? `\n\n${output}` : ''}`}</Pre>
        </ToolRow>
      );
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
  } else if (toolName === 'Bash') {
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
            Cần bạn cho phép vì {outside.length > 1 ? 'các file này nằm' : 'file này nằm'} ngoài thư mục đang mở:
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
  return (
    <div className="chat-column transcript">
      {items.map((it) => {
        switch (it.type) {
          case 'user':
            return (
              <div key={it.key} className="msg-user">
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
            );
          case 'text':
            return <AssistantText key={it.key} text={it.text} streaming={it.streaming} />;
          case 'tool':
            return <ToolItem key={it.key} item={it} running={running} onOpenFile={onOpenFile} />;
          case 'permission':
            return <PermissionCard key={it.key} item={it} onAnswer={onPermission} />;
          case 'result':
            return <ResultItem key={it.key} item={it} onOpenFile={onOpenFile} />;
          case 'error':
            return (
              <div key={it.key} className="msg-notice tone-warn">
                <span className="codicon codicon-warning" />
                {it.message}
              </div>
            );
          case 'local':
            return <LocalItem key={it.key} node={it.node} />;
        }
      })}
      {running && !waitingPermission && (
        <div className="working">
          <span className="codicon codicon-loading codicon-modifier-spin" /> Claude đang làm việc…
        </div>
      )}
    </div>
  );
}
