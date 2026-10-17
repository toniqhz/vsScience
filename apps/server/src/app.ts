import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { CloudProviderId, CloudStatus, FolderBusy, FolderSettings, ServerEvent, UpdateInfo } from '@ide/shared';
import { AgentSession, type QueryFn, type SessionApi } from './agent.js';
import { ArtifactStore, artifactTitle, artifactUrl, artifactsFromMessages, isDocsTool, linkTitle } from './artifacts.js';
import { ClaudeAuth } from './claude-auth.js';
import { Snapshots } from './snapshots.js';
import type { Config } from './config.js';
import { MIME_BY_EXT, PathError, isExecutable, resolveInWorkspace, toRelPosix, validateNewName } from './paths.js';
import { emptyDocx, emptyXlsx } from './templates.js';
import { openExternal, reveal } from './openExternal.js';
import { ContentSearch, flattenFiles, formatForClaude } from './search.js';
import { readFolderContext, writeFolderContext } from './folderContext.js';
import { PlanUsageMonitor, type UsageQueryFn } from './usage.js';
import { PackManager } from './packs.js';
import { packsDir, pythonHome } from './runtime.js';
import { loadProfile } from './profile.js';
import { buildTree } from './tree.js';
import { WorkspaceManager, listDirs, validateWorkspaceDir } from './workspace.js';
import { TurnNotifier, type AppNotification } from './notify.js';
import { FolderLocks, folderLocks } from './folderLock.js';
import { AutoSave } from './autoSave.js';
import { ensureFolderData } from './folderData.js';
import { CloudAccounts, type SecretBox } from './cloud/accounts.js';
import { FolderSync, MANIFEST, cloneFolder, listRemoteFolders } from './cloud/sync.js';
import { restoreHistory } from './snapshots.js';
import { releaseNotesBetween } from './releaseNotes.js';
import { readDeviceSettings, readFolderSettings, writeDeviceSettings, writeFolderSettings } from './settings.js';
import type { SummaryQueryFn } from './turnSummary.js';

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function tokenMatches(expected: Buffer, given: string | undefined): boolean {
  if (!given) return false;
  const buf = Buffer.from(given);
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

function requestToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // WebSocket trong trình duyệt không gửi được header, nên cho phép ?token=
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' ? q : undefined;
}

export type AppConfig = Pick<
  Config,
  'initialWorkspace' | 'token' | 'webDist' | 'statePath' | 'claudeBin' | 'snapshotsDir' | 'usePolling'
> &
  Partial<Pick<Config, 'profileDir' | 'scratchDir' | 'artifactsDir'>>;

export async function buildApp(
  config: AppConfig,
  opts: {
    logger?: boolean;
    watch?: boolean;
    queryFn?: QueryFn;
    sessions?: SessionApi;
    /** Mở file bằng ứng dụng ngoài (Word, Excel…); test truyền hàm giả để không bật ứng dụng thật. */
    openExternal?: (absPath: string) => Promise<void>;
    /** Truy vấn hạn mức gói Claude.ai (test truyền bản giả). */
    usageQueryFn?: UsageQueryFn;
    /** App desktop: mở thư mục trong một cửa sổ mới (mỗi cửa sổ có server và phiên Claude riêng). */
    openWindow?: (dir: string) => Promise<void>;
    /** App desktop: chọn thư mục bằng hộp thoại của máy rồi mở cửa sổ mới; false nếu người dùng bỏ chọn. */
    newWindow?: () => Promise<boolean>;
    /** App desktop: đưa cửa sổ này lên trước (khi cửa sổ khác bấm "Chuyển tới cửa sổ đó"). */
    focusWindow?: () => void;
    /** App desktop: mã hóa mã đăng nhập tài khoản đám mây bằng kho bảo mật của hệ điều hành. */
    secrets?: SecretBox;
    /** Ổ đám mây thử nghiệm (một thư mục trên máy); mặc định đọc từ biến IDE_FAKE_CLOUD_DIR. */
    cloudLocalDir?: string;
    /** Tên máy ghi vào bản đồng bộ (mặc định tên máy tính; test đặt tên để giả lập hai máy). */
    cloudDevice?: string;
    /** Tóm tắt câu hỏi làm mô tả bản lưu tự động (test truyền bản giả). */
    summaryQueryFn?: SummaryQueryFn;
    /** Bộ khóa thư mục dùng chung giữa các cửa sổ (test truyền bộ riêng). */
    folderLocks?: FolderLocks;
    /** Hiện file/thư mục trong trình quản lý file (app desktop dùng API của Electron). */
    reveal?: (absPath: string, isDir: boolean) => Promise<void>;
    /** Chuyển vào Thùng rác (app desktop). Không có thì xóa hẳn. */
    trashItem?: (absPath: string) => Promise<void>;
    /** Đọc chữ PDF cho ô tìm kiếm (test truyền bản giả thay cho Python). */
    readPdf?: (files: string[]) => Promise<Map<string, string[] | null>>;
    /** App desktop: kiểm tra và cài bản mới. */
    updater?: {
      status(): UpdateInfo;
      check(): Promise<UpdateInfo>;
      install(): void;
      /** Báo khi trạng thái đổi; trả về hàm hủy đăng ký. */
      subscribe(fn: (u: UpdateInfo) => void): () => void;
    };
    /** App desktop: thông báo của hệ điều hành khi Claude xong việc, hỏi lại hoặc cần cho phép. */
    notifier?: {
      enabled(): boolean;
      setEnabled(on: boolean): void;
      notify(n: AppNotification): void;
    };
  } = {},
) {
  const app = Fastify({ logger: opts.logger ?? false });
  /** Máy đã dùng app trước lần chạy này (có state.json): phân biệt "vừa cập nhật từ bản cũ" với "cài lần đầu". */
  const usedBefore = existsSync(config.statePath);
  const expectedToken = Buffer.from(config.token);
  const sockets = new Set<{ send(data: string): void }>();

  function broadcast(event: ServerEvent) {
    const data = JSON.stringify(event);
    for (const s of sockets) s.send(data);
  }

  // File mới xuất hiện trong thư mục khi Claude đang làm (và vài giây sau, vì trình theo dõi báo trễ):
  // coi là sản phẩm của Claude, đưa vào mục Artifact.
  const AFTER_TURN_MS = 8000;
  let claudeBusyUntil = 0;
  let onClaudeFiles: (paths: string[]) => void = () => {};
  const workspace = new WorkspaceManager({
    statePath: config.statePath,
    usePolling: config.usePolling,
    watch: opts.watch ?? true,
    emit: (event) => {
      broadcast(event);
      if (event.type === 'fs' && Date.now() <= claudeBusyUntil) {
        const added = event.changes.filter((c) => c.event === 'add').map((c) => c.path);
        if (added.length) onClaudeFiles(added);
      }
    },
  });
  await workspace.open(config.initialWorkspace);
  app.addHook('onClose', () => workspace.close());

  const snapshots = new Snapshots(config.snapshotsDir);
  // Lần đầu lưu cả thư mục có thể lâu: chạy ngầm, các thao tác bản lưu sau sẽ tự đợi.
  const openSnapshots = (root: string) =>
    snapshots
      .open(root)
      .then(() => broadcast({ type: 'changes-changed' }))
      .catch((err) => app.log.error(err));
  void openSnapshots(workspace.root);
  const auth = new ClaudeAuth(config.claudeBin);
  app.addHook('onClose', async () => auth.cancel());
  const planUsage = new PlanUsageMonitor(config.claudeBin, opts.usageQueryFn);
  const packs = new PackManager(pythonHome(), packsDir(), (pack) => broadcast({ type: 'pack', pack }));
  // Trang (artifact) Claude đăng lên claude.ai: lưu bản sao HTML để xem lại trong app.
  const artifacts = new ArtifactStore(config.artifactsDir ?? path.join(path.dirname(config.snapshotsDir), 'artifacts'));
  const recordLink = async (toolName: string, input: Record<string, unknown>, output: string, cwd: string) => {
    const url = artifactUrl(output);
    if (!url) return;
    if (await artifacts.recordLinks(cwd, [{ url, title: linkTitle(input), doc: isDocsTool(toolName) }])) broadcast({ type: 'artifacts-changed' });
  };
  const recordArtifact = async (input: Record<string, unknown>, output: string, cwd: string) => {
    const file = typeof input.file_path === 'string' ? path.resolve(cwd, input.file_path) : null;
    if (!file || !/\.html?$/i.test(file)) {
      // Trang không phải HTML (ví dụ Markdown): vẫn giữ link để mở trên claude.ai.
      return recordLink('Artifact', input, output, cwd);
    }
    const html = await readFile(file, 'utf8');
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    await artifacts.record(cwd, {
      title: artifactTitle(html, file, str(input.title)),
      description: str(input.description),
      url: artifactUrl(output),
      fileName: path.basename(file),
      html,
    });
    broadcast({ type: 'artifacts-changed' });
  };
  onClaudeFiles = (paths) =>
    void artifacts
      .recordFiles(workspace.root, paths.map((p) => ({ path: p })))
      .then((added) => added && broadcast({ type: 'artifacts-changed' }))
      .catch((err) => app.log.error(err));
  const contentSearch = new ContentSearch(opts.readPdf);
  /** Tìm trong nội dung các file của thư mục làm việc (giới hạn trong thư mục con/file `under` nếu có). */
  async function searchWorkspace(q: string, under?: string) {
    const root = workspace.root;
    const rel = under && path.isAbsolute(under) ? path.relative(root, under) : (under ?? '');
    const prefix = rel.startsWith('..') ? '' : rel.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '').normalize('NFC');
    const files = flattenFiles(root, (await buildTree(root)).root).filter((f) => !prefix || f.rel.normalize('NFC') === prefix || f.rel.normalize('NFC').startsWith(`${prefix}/`));
    return contentSearch.search(files, q);
  }

  const turnNotifier = new TurnNotifier(() => path.basename(workspace.root));
  const settingsPath = path.join(path.dirname(config.statePath), 'settings.json');
  // App desktop: thông báo của hệ điều hành. Trình duyệt: gửi cho trang tự hiện thông báo của trình duyệt.
  const notifier = opts.notifier ?? {
    enabled: () => readDeviceSettings(settingsPath).notifications,
    setEnabled: (on: boolean) => void writeDeviceSettings(settingsPath, { notifications: on }),
    notify: (n: AppNotification) => broadcast({ type: 'notify', title: n.title, body: n.body }),
  };
  // Khóa thư mục khi Claude đang làm: cửa sổ khác cùng thư mục (hoặc thư mục cha/con) không gửi được tin nhắn.
  const locks = opts.folderLocks ?? folderLocks;
  const lockId = randomUUID();
  const busyElsewhere = (): FolderBusy | null => {
    const h = locks.conflict(lockId, workspace.root);
    return h ? { folder: path.basename(h.root), root: h.root } : null;
  };
  let lastBusy = '';
  const broadcastLock = () => {
    const busy = busyElsewhere();
    const key = JSON.stringify(busy);
    if (key === lastBusy) return;
    lastBusy = key;
    broadcast({ type: 'lock', busyElsewhere: busy });
  };
  const unsubscribeLocks = locks.subscribe(broadcastLock);
  app.addHook('onClose', async () => {
    unsubscribeLocks();
    locks.release(lockId);
  });
  // Tự lưu khi Claude xong một việc đủ lớn (thay đổi đủ nhiều và đã làm trọn yêu cầu); mô tả là tóm tắt yêu cầu.
  const autoSave = new AutoSave({
    enabled: () => readFolderSettings(workspace.root).autoSave,
    snapshots,
    claudeBin: config.claudeBin,
    queryFn: opts.summaryQueryFn,
    onSaved: () => {
      broadcast({ type: 'changes-changed' });
      syncAfterSave();
    },
    onError: (err) => app.log.error(err),
  });
  // ---------- Đồng bộ đám mây: mỗi khi có bản lưu mới, đẩy thư mục lên ổ đám mây (nếu đã bật) ----------
  const cloudDir = path.join(path.dirname(config.statePath), 'cloud');
  const accounts = new CloudAccounts({
    dir: cloudDir,
    secrets: opts.secrets,
    localDriveDir: opts.cloudLocalDir ?? (process.env.IDE_FAKE_CLOUD_DIR || undefined),
    onChange: () => void broadcastCloud(),
  });
  const folderSync = new FolderSync({
    root: () => workspace.root,
    drive: (id) => accounts.drive(id as CloudProviderId),
    snapshots,
    statePath: (folderId) => path.join(cloudDir, 'folders', `${folderId}.json`),
    onStatus: () => void broadcastCloud(),
    // Không lấy bản từ máy khác về khi Claude đang sửa file.
    canPull: () => !agent.running,
    device: opts.cloudDevice,
  });
  /** Đang tải một thư mục từ mây về (tiến độ hiện trong hộp thoại Mở thư mục). */
  let cloning: CloudStatus['clone'];
  // Lấy bản mới của máy khác: khi mở thư mục và mỗi 5 phút.
  const pullIfSynced = () => {
    if (readFolderSettings(workspace.root).cloud) void folderSync.pull();
  };
  const pullTimer = setInterval(pullIfSynced, 5 * 60_000);
  pullTimer.unref();
  app.addHook('onClose', async () => clearInterval(pullTimer));
  setTimeout(pullIfSynced, 1500).unref();
  async function cloudStatus(): Promise<CloudStatus> {
    const cfg = readFolderSettings(workspace.root).cloud;
    return {
      providers: await accounts.providers(),
      folder: cfg ? { provider: cfg.provider, remoteName: cfg.remoteName } : null,
      sync: folderSync.status(),
      ...(accounts.connecting ? { connecting: accounts.connecting } : {}),
      ...(cloning ? { clone: cloning } : {}),
    };
  }
  async function broadcastCloud() {
    broadcast({ type: 'cloud', cloud: await cloudStatus() });
  }
  function syncAfterSave() {
    if (readFolderSettings(workspace.root).cloud) void folderSync.push();
  }
  const BUSY_HERE = 'Claude đang làm việc. Bấm dừng hoặc chờ Claude xong rồi mới chuyển.';
  const agent = new AgentSession({
    cwd: () => workspace.root,
    claudeBin: config.claudeBin,
    emit: (event) => {
      broadcast({ type: 'agent', event });
      if (event.kind === 'status' && event.state === 'idle') locks.release(lockId);
      autoSave.onEvent(event);
      const note = turnNotifier.next(event);
      if (note && notifier.enabled()) notifier.notify(note);
      if (event.kind === 'status') claudeBusyUntil = event.state === 'running' ? Infinity : Date.now() + AFTER_TURN_MS;
      // Mỗi lượt dùng thêm hạn mức: lấy số liệu mới cho ô hạn mức.
      if (event.kind === 'result') void planUsage.get(true).then((usage) => usage && broadcast({ type: 'usage', usage }));
    },
    replay: (events) => broadcast({ type: 'agent-replay', events }),
    onSessionsChanged: () => broadcast({ type: 'sessions-changed' }),
    onArtifact: (input, output, cwd) => void recordArtifact(input, output, cwd).catch((err) => app.log.error(err)),
    onArtifactLink: (toolName, input, output, cwd) => void recordLink(toolName, input, output, cwd).catch((err) => app.log.error(err)),
    // Tự lưu bản trước mỗi lượt để có thể hoàn tác đúng phần Claude đã sửa.
    // Lần tự lưu của lượt trước (đang đánh giá) phải xong trước, để không lẫn thay đổi của lượt mới.
    beforeTurn: () => autoSave.idle(),
    profile: () => loadProfile(config.profileDir ?? null),
    searchDocuments: async (q, under) => formatForClaude(await searchWorkspace(q, under), q),
    scratchRoot: config.scratchDir,
    queryFn: opts.queryFn,
    sessions: opts.sessions,
  });
  app.addHook('onClose', () => agent.close());

  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    // Chống DNS rebinding: chỉ nhận Host là địa chỉ loopback.
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!ALLOWED_HOSTNAMES.has(hostname)) {
      return reply.code(403).send({ error: 'Host không được phép' });
    }
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    if (!tokenMatches(expectedToken, requestToken(req))) {
      return reply.code(401).send({ error: 'Thiếu hoặc sai token truy cập' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PathError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'Yêu cầu không hợp lệ' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Lỗi máy chủ' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Đăng nhập Claude.ai qua Claude Code CLI (giống plugin VS Code).
  app.get('/api/auth/status', async () => auth.status());
  app.post('/api/auth/login', async () => auth.startLogin());
  app.get('/api/auth/login', async () => auth.progress());
  app.post<{ Body: { code: string } }>(
    '/api/auth/login/code',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (req) => {
      auth.submitCode(req.body.code);
      return auth.progress();
    },
  );
  app.post('/api/auth/login/cancel', async () => {
    auth.cancel();
    return auth.progress();
  });
  app.post('/api/auth/logout', async () => {
    await auth.logout();
    return auth.status();
  });

  app.get('/api/workspace', async () => workspace.info());

  /** Bối cảnh thư mục (chủ đề, người đọc, chuẩn trích dẫn…) lưu trong CLAUDE.md của thư mục. */
  app.get('/api/workspace/context', async () => readFolderContext(workspace.root));
  app.post<{ Body: Record<string, string> }>(
    '/api/workspace/context',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            ['topic', 'audience', 'purpose', 'level', 'citationStyle', 'language', 'notes'].map((k) => [k, { type: 'string', maxLength: 4000 }]),
          ),
        },
      },
    },
    async (req) => {
      const ctx = { ...(await readFolderContext(workspace.root)), ...req.body };
      await writeFolderContext(workspace.root, ctx);
      // Phiên Claude đọc CLAUDE.md khi bắt đầu: lượt sau mở lại phiên (giữ hội thoại) để thấy bối cảnh mới.
      agent.requestRestart();
      return ctx;
    },
  );

  app.post<{ Body: { path: string } }>(
    '/api/window',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req, reply) => {
      if (!opts.openWindow) return reply.code(404).send({ error: 'Chỉ app desktop mới mở được cửa sổ mới' });
      await opts.openWindow(await validateWorkspaceDir(req.body.path));
      return { ok: true };
    },
  );

  app.post('/api/window/new', async (_req, reply) => {
    if (!opts.newWindow) return reply.code(404).send({ error: 'Chỉ app desktop mới mở được cửa sổ mới' });
    return { opened: await opts.newWindow() };
  });

  app.post<{ Body: { path: string } }>(
    '/api/workspace',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req, reply) => {
      if (agent.running) return reply.code(409).send({ error: BUSY_HERE });
      const info = await workspace.open(req.body.path);
      // Phiên trợ lý và bản lưu gắn với thư mục làm việc.
      await agent.clear();
      void openSnapshots(info.root);
      broadcastLock();
      folderSync.reset();
      pullIfSynced();
      return info;
    },
  );

  // ---------- Trợ lý (Agent SDK) ----------
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  app.post<{
    Body: { text: string; files: string[]; model: string; effort: string | null; mode: 'ask' | 'auto' | 'plan' | 'lazy'; remote?: boolean };
  }>(
    '/api/agent/message',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text', 'files', 'model', 'mode'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 100_000 },
            files: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 4096 } },
            model: { type: 'string', pattern: '^claude-[a-z0-9-]+$', maxLength: 64 },
            effort: { anyOf: [{ type: 'string', enum: EFFORTS }, { type: 'null' }] },
            mode: { type: 'string', enum: ['ask', 'auto', 'plan', 'lazy'] },
            remote: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { text, files, model, effort, mode, remote } = req.body;
      const other = locks.acquire({ id: lockId, root: workspace.root, focus: opts.focusWindow });
      if (other) {
        broadcastLock();
        return reply.code(409).send({
          error: `Claude đang làm việc trong thư mục «${path.basename(other.root)}» ở cửa sổ khác. Chờ bên đó xong (hoặc dừng ở cửa sổ đó) rồi gửi lại, để hai bên không cùng sửa một file.`,
        });
      }
      try {
        await agent.send(text, files, { model, effort: (effort as never) ?? null, mode, remote: !!remote });
      } catch (err) {
        if (!agent.running) locks.release(lockId);
        throw err;
      }
      return { ok: true };
    },
  );
  /** Đổi chế độ cấp quyền ngay (kể cả khi Claude đang làm dở). */
  app.post<{ Body: { mode: 'ask' | 'auto' | 'plan' | 'lazy' } }>(
    '/api/agent/mode',
    { schema: { body: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['ask', 'auto', 'plan', 'lazy'] } } } } },
    async (req) => {
      await agent.setMode(req.body.mode);
      return { ok: true };
    },
  );
  /** Bật/tắt Remote Control (điều khiển phiên từ claude.ai/code hoặc app Claude trên điện thoại). */
  app.post<{ Body: { model: string; effort: string | null; mode: 'ask' | 'auto' | 'plan' | 'lazy'; remote: boolean } }>(
    '/api/agent/remote',
    {
      schema: {
        body: {
          type: 'object',
          required: ['model', 'mode', 'remote'],
          properties: {
            model: { type: 'string', pattern: '^claude-[a-z0-9-]+$', maxLength: 64 },
            effort: { anyOf: [{ type: 'string', enum: EFFORTS }, { type: 'null' }] },
            mode: { type: 'string', enum: ['ask', 'auto', 'plan', 'lazy'] },
            remote: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { model, effort, mode, remote } = req.body;
      try {
        const info = await agent.setRemote({ model, effort: (effort as never) ?? null, mode, remote });
        return { remote: agent.remote, info: info ?? null };
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    },
  );
  app.post('/api/agent/interrupt', async () => {
    await agent.interrupt();
    return { ok: true };
  });
  app.post<{ Body: { id: string; allow: boolean; always?: boolean } }>(
    '/api/agent/permission',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id', 'allow'],
          properties: { id: { type: 'string', maxLength: 64 }, allow: { type: 'boolean' }, always: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      if (!agent.respondPermission(req.body.id, req.body.allow, req.body.always)) {
        return reply.code(404).send({ error: 'Yêu cầu này đã hết hạn' });
      }
      return { ok: true };
    },
  );
  /** Cài đặt của thư mục làm việc (tự lưu, lựa chọn của ô chat). */
  app.get('/api/settings', async () => readFolderSettings(workspace.root));
  app.post<{ Body: Partial<FolderSettings> }>(
    '/api/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            autoSave: { type: 'boolean' },
            chat: {
              type: 'object',
              required: ['model', 'mode'],
              additionalProperties: false,
              properties: {
                model: { type: 'string', maxLength: 100 },
                effort: { type: ['string', 'null'], maxLength: 20 },
                mode: { type: 'string', enum: ['ask', 'auto', 'plan', 'lazy'] },
                remote: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await ensureFolderData(workspace.root))) return reply.code(409).send({ error: 'Thư mục này không ghi được cài đặt' });
      return writeFolderSettings(workspace.root, req.body);
    },
  );
  /** Đồng bộ đám mây: tài khoản trên máy này và trạng thái đồng bộ của thư mục đang mở. */
  const providerSchema = { type: 'string', enum: ['onedrive', 'gdrive', 'local'] } as const;
  app.get('/api/cloud', async () => cloudStatus());
  app.post<{ Body: { provider: CloudProviderId } }>(
    '/api/cloud/connect',
    { schema: { body: { type: 'object', required: ['provider'], properties: { provider: providerSchema } } } },
    async (req) => accounts.connect(req.body.provider),
  );
  app.post('/api/cloud/connect/cancel', async () => {
    accounts.cancelConnect();
    return { ok: true };
  });
  app.post<{ Body: { provider: CloudProviderId } }>(
    '/api/cloud/disconnect',
    { schema: { body: { type: 'object', required: ['provider'], properties: { provider: providerSchema } } } },
    async (req) => {
      await accounts.disconnect(req.body.provider);
      return cloudStatus();
    },
  );
  /** Bật đồng bộ thư mục đang mở lên một nhà cung cấp (đẩy lên ngay), hoặc tắt (dữ liệu trên ổ vẫn giữ). */
  app.post<{ Body: { enabled: boolean; provider?: CloudProviderId } }>(
    '/api/cloud/folder',
    { schema: { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' }, provider: providerSchema } } } },
    async (req, reply) => {
      const root = workspace.root;
      if (!req.body.enabled) {
        const { cloud: _off, ...rest } = readFolderSettings(root);
        writeFolderSettings(root, rest, true);
        folderSync.reset();
        return cloudStatus();
      }
      const provider = req.body.provider ?? 'onedrive';
      const drive = await accounts.drive(provider);
      if (!drive) return reply.code(409).send({ error: 'Hãy kết nối tài khoản trước' });
      if (!(await ensureFolderData(root))) return reply.code(409).send({ error: 'Thư mục này không ghi được' });
      // Tên trên ổ: tên thư mục; đã có thư mục khác cùng tên thì thêm (2), (3)…
      const base = path.basename(root).replace(/[\\/:*?"<>|]/g, '_').trim() || 'Thư mục';
      const folderId = readFolderSettings(root).cloud?.folderId ?? randomUUID();
      let remoteName = base;
      for (let n = 2; n < 100; n++) {
        const existing = await drive.read(`${remoteName}/${MANIFEST}`);
        if (!existing || (JSON.parse(existing.data.toString('utf8')) as { folderId?: string }).folderId === folderId) break;
        remoteName = `${base} (${n})`;
      }
      writeFolderSettings(root, { cloud: { provider, folderId, remoteName } });
      void folderSync.push();
      return cloudStatus();
    },
  );
  /** Các thư mục đã đồng bộ trên ổ của một tài khoản (để tải về máy này). */
  app.get<{ Querystring: { provider: CloudProviderId } }>(
    '/api/cloud/folders',
    { schema: { querystring: { type: 'object', required: ['provider'], properties: { provider: providerSchema } } } },
    async (req, reply) => {
      const drive = await accounts.drive(req.query.provider);
      if (!drive) return reply.code(409).send({ error: 'Hãy kết nối tài khoản trước' });
      return listRemoteFolders(drive);
    },
  );
  /** Tải một thư mục từ ổ về `parent/<tên>` (rồi trang mở thư mục đó). */
  app.post<{ Body: { provider: CloudProviderId; name: string; parent: string } }>(
    '/api/cloud/clone',
    {
      schema: {
        body: {
          type: 'object',
          required: ['provider', 'name', 'parent'],
          properties: { provider: providerSchema, name: { type: 'string', minLength: 1, maxLength: 255 }, parent: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req, reply) => {
      if (cloning) return reply.code(409).send({ error: 'Đang tải một thư mục khác về' });
      const drive = await accounts.drive(req.body.provider);
      if (!drive) return reply.code(409).send({ error: 'Hãy kết nối tài khoản trước' });
      const name = req.body.name;
      if (/[\\/]|^\.\.?$/.test(name)) return reply.code(400).send({ error: 'Tên thư mục không hợp lệ' });
      const parent = await validateWorkspaceDir(req.body.parent);
      const target = path.join(parent, name);
      cloning = { name, done: 0, total: 0 };
      void broadcastCloud();
      try {
        await cloneFolder({
          drive,
          remoteName: name,
          target,
          statePath: (folderId) => path.join(cloudDir, 'folders', `${folderId}.json`),
          restoreHistory,
          onProgress: (done, total) => {
            cloning = { name, done, total };
            void broadcastCloud();
          },
        });
      } finally {
        cloning = undefined;
        void broadcastCloud();
      }
      return { path: target };
    },
  );
  app.post('/api/cloud/sync', async (_req, reply) => {
    if (!readFolderSettings(workspace.root).cloud) return reply.code(409).send({ error: 'Thư mục này chưa bật đồng bộ' });
    void folderSync.push();
    return cloudStatus();
  });
  app.get('/api/agent/lock', async () => ({ busyElsewhere: busyElsewhere() }));
  /** Chuyển tới cửa sổ đang có Claude làm việc trong thư mục này. */
  app.post('/api/agent/lock/focus', async (_req, reply) => {
    const h = locks.conflict(lockId, workspace.root);
    if (!h?.focus) return reply.code(404).send({ error: 'Không còn cửa sổ nào khác đang làm trong thư mục này' });
    h.focus();
    return { ok: true };
  });
  app.post('/api/agent/clear', async (_req, reply) => {
    if (agent.running) return reply.code(409).send({ error: BUSY_HERE });
    await agent.clear();
    return { ok: true };
  });
  // Gói tùy chọn (thư viện Python cài thêm khi người dùng đồng ý).
  app.get('/api/packs', async () => packs.list());
  app.post<{ Body: { id: string } }>(
    '/api/packs/install',
    { schema: { body: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } } } } },
    async (req) => packs.install(req.body.id),
  );
  app.get<{ Querystring: { refresh?: string } }>('/api/usage', async (req) => ({
    usage: await planUsage.get(req.query.refresh === '1'),
  }));
  /** Cập nhật app (chỉ app desktop). */
  const updater = opts.updater;
  if (updater) {
    const unsubscribe = updater.subscribe((update) => broadcast({ type: 'update', update }));
    app.addHook('onClose', async () => unsubscribe());
  }
  app.get('/api/update', async (_req, reply) => (updater ? updater.status() : reply.code(404).send({ error: 'Chỉ app desktop mới cập nhật được' })));
  app.post('/api/update/check', async (_req, reply) => (updater ? updater.check() : reply.code(404).send({ error: 'Chỉ app desktop mới cập nhật được' })));
  /** Bật/tắt thông báo (cài đặt chung cho mọi cửa sổ). */
  app.get('/api/notifications', async () => ({ supported: true, enabled: notifier.enabled() }));
  app.post<{ Body: { enabled: boolean } }>(
    '/api/notifications',
    { schema: { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
    async (req, reply) => {
      notifier.setEnabled(req.body.enabled);
      return { supported: true, enabled: notifier.enabled() };
    },
  );
  /**
   * "Có gì mới" sau khi cập nhật: phiên bản đang chạy (app desktop) và phiên bản đã xem lần trước trên máy này.
   * Trang so hai bản để hiện các thay đổi ở giữa; xem xong thì báo đã xem.
   */
  /** Ghi chú "Có gì mới" của bản mới chưa cài (từ GitHub Releases), để xem trước khi cập nhật. */
  app.get('/api/update/notes', async (_req, reply) => {
    const u = updater?.status();
    if (!u?.latest) return reply.code(404).send({ error: 'Chưa có bản mới' });
    try {
      return await releaseNotesBetween(u.current, u.latest);
    } catch (err) {
      return reply.code(502).send({ error: `Không tải được ghi chú bản mới: ${(err as Error).message}` });
    }
  });
  app.get('/api/whatsnew', async () => ({
    current: updater?.status().current ?? null,
    lastSeen: readDeviceSettings(settingsPath).lastSeenVersion ?? null,
    // Bản cũ (trước 0.1.16) chưa ghi "bản đã xem": có dữ liệu cũ mà chưa có bản đã xem là vừa cập nhật.
    usedBefore,
  }));
  app.post<{ Body: { version: string } }>(
    '/api/whatsnew/seen',
    { schema: { body: { type: 'object', required: ['version'], properties: { version: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+){1,3}$' } } } } },
    async (req) => {
      writeDeviceSettings(settingsPath, { lastSeenVersion: req.body.version });
      return { ok: true };
    },
  );
  app.post('/api/update/install', async (_req, reply) => {
    if (!updater) return reply.code(404).send({ error: 'Chỉ app desktop mới cập nhật được' });
    if (!updater.status().canInstall) return reply.code(409).send({ error: 'Chưa có bản cập nhật đã tải xong' });
    // Trả lời trước rồi mới thoát app để cài.
    setTimeout(() => updater.install(), 300);
    return { ok: true };
  });

  app.get('/api/agent/profile', async () => ({ profile: loadProfile(config.profileDir ?? null)?.info ?? null }));
  app.get('/api/agent/context', async () => ({ usage: await agent.contextUsage() }));
  /** Connector (máy chủ MCP) Claude dùng được: của tài khoản claude.ai và cấu hình trên máy. */
  app.get<{ Querystring: { refresh?: string } }>('/api/connectors', async (req) => ({
    connectors: await agent.connectors(req.query.refresh === '1'),
  }));
  app.post<{ Body: { key: string } }>(
    '/api/connectors/reconnect',
    { schema: { body: { type: 'object', required: ['key'], properties: { key: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (req) => ({ connectors: await agent.reconnectConnector(req.body.key) }),
  );

  const sessionIdSchema = { type: 'string', pattern: '^[A-Za-z0-9-]{1,100}$' } as const;

  app.get('/api/artifacts', async () => {
    const cwd = workspace.root;
    // Lần đầu với thư mục này: lấy lại các file Claude đã tạo trong các phiên trước.
    await artifacts.backfill(cwd, async () => artifactsFromMessages(cwd, await agent.allSessionMessages()));
    return artifacts.list(cwd);
  });
  app.get<{ Querystring: { id: string } }>(
    '/api/artifacts/content',
    { schema: { querystring: { type: 'object', required: ['id'], properties: { id: sessionIdSchema } } } },
    async (req, reply) => {
      const html = await artifacts.content(workspace.root, req.query.id);
      if (html === null) return reply.code(404).send({ error: 'Không còn bản lưu của trang này' });
      return { html };
    },
  );
  app.post<{ Body: { id: string } }>(
    '/api/artifacts/delete',
    { schema: { body: { type: 'object', required: ['id'], properties: { id: sessionIdSchema } } } },
    async (req) => {
      await artifacts.remove(workspace.root, req.body.id);
      broadcast({ type: 'artifacts-changed' });
      return { ok: true };
    },
  );
  app.get('/api/agent/sessions', async () => agent.listSessions());
  app.post<{ Body: { id: string } }>(
    '/api/agent/sessions/open',
    { schema: { body: { type: 'object', required: ['id'], properties: { id: sessionIdSchema } } } },
    async (req, reply) => {
      if (agent.running) return reply.code(409).send({ error: BUSY_HERE });
      await agent.openSession(req.body.id);
      return { ok: true };
    },
  );
  app.post<{ Body: { id: string; title: string } }>(
    '/api/agent/sessions/rename',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id', 'title'],
          properties: { id: sessionIdSchema, title: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => {
      await agent.renameSession(req.body.id, req.body.title.trim());
      return { ok: true };
    },
  );
  app.post<{ Body: { id: string } }>(
    '/api/agent/sessions/delete',
    { schema: { body: { type: 'object', required: ['id'], properties: { id: sessionIdSchema } } } },
    async (req, reply) => {
      if (agent.running && req.body.id === agent.sessionId) return reply.code(409).send({ error: BUSY_HERE });
      await agent.deleteSession(req.body.id);
      return { ok: true };
    },
  );

  // ---------- Bản lưu (git chạy ngầm) ----------
  const pathBody = {
    body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } },
  } as const;
  app.get('/api/changes', async () => snapshots.status());
  app.get<{ Querystring: { path?: string } }>('/api/changes/diff', async (req) => snapshots.diff(req.query.path ?? ''));
  app.post<{ Body: { message?: string } }>(
    '/api/changes/snapshot',
    { schema: { body: { type: 'object', properties: { message: { type: 'string', maxLength: 500 } } } } },
    async (req) => {
      const saved = await snapshots.snapshot(req.body.message ?? '');
      broadcast({ type: 'changes-changed' });
      if (saved) syncAfterSave();
      return { saved };
    },
  );
  const snapshotId = { type: 'string', pattern: '^[0-9a-f]{4,40}$' } as const;
  app.get<{ Querystring: { id: string } }>(
    '/api/changes/snapshots/detail',
    { schema: { querystring: { type: 'object', required: ['id'], properties: { id: snapshotId } } } },
    async (req) => snapshots.snapshotDetail(req.query.id),
  );
  app.get<{ Querystring: { id: string; path: string } }>(
    '/api/changes/snapshots/diff',
    { schema: { querystring: { type: 'object', required: ['id', 'path'], properties: { id: snapshotId, path: { type: 'string', minLength: 1 } } } } },
    async (req) => snapshots.snapshotDiff(req.query.id, req.query.path),
  );
  app.post<{ Body: { id: string; path?: string } }>(
    '/api/changes/snapshots/restore',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id'],
          properties: { id: snapshotId, path: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req) => {
      const result = await snapshots.restoreSnapshot(req.body.id, req.body.path);
      broadcast({ type: 'changes-changed' });
      return result;
    },
  );
  app.post<{ Body: { path: string } }>('/api/changes/restore', { schema: pathBody }, async (req) => {
    await snapshots.restore(req.body.path);
    broadcast({ type: 'changes-changed' });
    return { ok: true };
  });

  /** Duyệt thư mục trên máy cho hộp thoại "Mở thư mục" (chỉ trả tên thư mục). */
  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (req) => listDirs(req.query.path || undefined));

  app.get('/api/tree', async () => buildTree(workspace.root));

  /** Tìm trong nội dung mọi file của thư mục làm việc. */
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    return searchWorkspace((req.query.q ?? '').slice(0, 200));
  });

  app.get<{ Querystring: { path?: string } }>('/api/file', async (req, reply) => {
    const rel = req.query.path ?? '';
    const abs = await resolveInWorkspace(workspace.root, rel);
    const st = await stat(abs);
    if (!st.isFile()) throw new PathError('Không phải file', 415);
    const ext = path.extname(abs).toLowerCase();
    return reply
      .header('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream')
      .header('content-length', st.size)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`)
      .send(createReadStream(abs));
  });

  /** Mở file bằng ứng dụng mặc định trên máy (Word, Excel) để người dùng tự sửa. */
  app.post<{ Body: { path: string } }>(
    '/api/file/open-external',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } } },
    async (req) => {
      const abs = await resolveInWorkspace(workspace.root, req.body.path);
      if (!(await stat(abs)).isFile()) throw new PathError('Không phải file', 415);
      if (isExecutable(abs)) throw new PathError('Không mở file chương trình hoặc script từ app (mở là máy sẽ chạy nó)', 415);
      await (opts.openExternal ?? openExternal)(abs);
      return { ok: true };
    },
  );

  /** Hiện file/thư mục trong File Explorer / Finder. Đường dẫn rỗng là chính thư mục làm việc. */
  app.post<{ Body: { path: string } }>(
    '/api/fs/reveal',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', maxLength: 4096 } } } } },
    async (req) => {
      const abs = req.body.path ? await resolveInWorkspace(workspace.root, req.body.path) : workspace.root;
      await (opts.reveal ?? reveal)(abs, (await stat(abs)).isDirectory());
      return { ok: true };
    },
  );

  /**
   * Xóa file/thư mục trong thư mục làm việc (app desktop: chuyển vào Thùng rác).
   * Xóa đúng mục được chọn: là liên kết (symlink) thì xóa liên kết, không đụng tới nơi nó trỏ tới.
   */
  app.post<{ Body: { path: string } }>(
    '/api/fs/delete',
    { schema: pathBody },
    async (req) => {
      const rel = req.body.path.replace(/[\\/]+$/, '');
      const slash = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
      const parent = await resolveInWorkspace(workspace.root, slash < 0 ? '' : rel.slice(0, slash));
      const name = rel.slice(slash + 1);
      if (!name || name === '.' || name === '..') throw new PathError('Không xóa được thư mục làm việc', 400);
      const abs = path.join(parent, name);
      await lstat(abs).catch(() => {
        throw new PathError('Không tìm thấy', 404);
      });
      if (opts.trashItem) await opts.trashItem(abs);
      else await rm(abs, { recursive: true });
      return { ok: true, trashed: !!opts.trashItem };
    },
  );

  const createBody = {
    body: {
      type: 'object',
      required: ['parent', 'name'],
      properties: {
        parent: { type: 'string', maxLength: 4096 },
        name: { type: 'string', minLength: 1, maxLength: 255 },
      },
    },
  } as const;

  /** Đường dẫn tuyệt đối cho mục mới trong thư mục `parent` (tương đối so với thư mục làm việc). */
  async function newItemPath(parent: string, name: string): Promise<string> {
    const dir = await resolveInWorkspace(workspace.root, parent);
    if (!(await stat(dir)).isDirectory()) throw new PathError('Thư mục cha không tồn tại', 400);
    return path.join(dir, validateNewName(name));
  }

  function alreadyExists(err: unknown): never {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new PathError('Đã có file hoặc thư mục trùng tên', 409);
    throw err;
  }

  app.post<{ Body: { parent: string; name: string } }>('/api/fs/folder', { schema: createBody }, async (req, reply) => {
    const abs = await newItemPath(req.body.parent, req.body.name);
    await mkdir(abs).catch(alreadyExists);
    return reply.code(201).send({ path: toRelPosix(workspace.root, abs) });
  });

  /** Tạo file Word/Excel trống. Không có đuôi thì mặc định là .docx. */
  app.post<{ Body: { parent: string; name: string } }>('/api/fs/file', { schema: createBody }, async (req, reply) => {
    let name = req.body.name.trim();
    if (!path.extname(name)) name += '.docx';
    const ext = path.extname(name).toLowerCase();
    const content = ext === '.docx' ? emptyDocx() : ext === '.xlsx' ? emptyXlsx() : null;
    if (!content) throw new PathError('Chỉ tạo được file Word (.docx) hoặc Excel (.xlsx)', 400);
    const abs = await newItemPath(req.body.parent, name);
    await writeFile(abs, content, { flag: 'wx' }).catch(alreadyExists);
    return reply.code(201).send({ path: toRelPosix(workspace.root, abs) });
  });

  app.get('/api/events', { websocket: true }, (socket) => {
    sockets.add(socket);
    const hello: ServerEvent = { type: 'hello', workspace: workspace.info() };
    socket.send(JSON.stringify(hello));
    const replay: ServerEvent = { type: 'agent-replay', events: agent.events() };
    socket.send(JSON.stringify(replay));
    socket.send(JSON.stringify({ type: 'lock', busyElsewhere: busyElsewhere() } satisfies ServerEvent));
    socket.on('close', () => sockets.delete(socket));
  });

  // Bản build của web (khi chạy không qua Vite).
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Không tìm thấy' });
    });
  }

  return { app, workspace };
}
