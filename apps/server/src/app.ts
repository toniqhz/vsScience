import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { ServerEvent } from '@ide/shared';
import { AgentSession, type QueryFn, type SessionApi } from './agent.js';
import { ClaudeAuth } from './claude-auth.js';
import { Snapshots } from './snapshots.js';
import type { Config } from './config.js';
import { MIME_BY_EXT, PathError, fileKind, resolveInWorkspace, toRelPosix, validateNewName } from './paths.js';
import { emptyDocx, emptyXlsx } from './templates.js';
import { openExternal } from './openExternal.js';
import { loadProfile } from './profile.js';
import { buildTree } from './tree.js';
import { WorkspaceManager, listDirs } from './workspace.js';

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
  Partial<Pick<Config, 'profileDir'>>;

export async function buildApp(
  config: AppConfig,
  opts: {
    logger?: boolean;
    watch?: boolean;
    queryFn?: QueryFn;
    sessions?: SessionApi;
    /** Mở file bằng ứng dụng ngoài (Word, Excel…); test truyền hàm giả để không bật ứng dụng thật. */
    openExternal?: (absPath: string) => Promise<void>;
  } = {},
) {
  const app = Fastify({ logger: opts.logger ?? false });
  const expectedToken = Buffer.from(config.token);
  const sockets = new Set<{ send(data: string): void }>();

  function broadcast(event: ServerEvent) {
    const data = JSON.stringify(event);
    for (const s of sockets) s.send(data);
  }

  const workspace = new WorkspaceManager({
    statePath: config.statePath,
    usePolling: config.usePolling,
    watch: opts.watch ?? true,
    emit: broadcast,
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
  const agent = new AgentSession({
    cwd: () => workspace.root,
    claudeBin: config.claudeBin,
    emit: (event) => broadcast({ type: 'agent', event }),
    replay: (events) => broadcast({ type: 'agent-replay', events }),
    onSessionsChanged: () => broadcast({ type: 'sessions-changed' }),
    // Tự lưu bản trước mỗi lượt để có thể hoàn tác đúng phần Claude đã sửa.
    beforeTurn: async (text) => {
      const saved = await snapshots.snapshot(`Trước khi Claude làm: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
      if (saved) broadcast({ type: 'changes-changed' });
    },
    profile: () => loadProfile(config.profileDir ?? null),
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
    async (req) => {
      const info = await workspace.open(req.body.path);
      // Phiên trợ lý và bản lưu gắn với thư mục làm việc.
      await agent.clear();
      void openSnapshots(info.root);
      return info;
    },
  );

  // ---------- Trợ lý (Agent SDK) ----------
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  app.post<{
    Body: { text: string; files: string[]; model: string; effort: string | null; mode: 'ask' | 'auto' | 'plan' };
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
            mode: { type: 'string', enum: ['ask', 'auto', 'plan'] },
          },
        },
      },
    },
    async (req) => {
      const { text, files, model, effort, mode } = req.body;
      await agent.send(text, files, { model, effort: (effort as never) ?? null, mode });
      return { ok: true };
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
  app.post('/api/agent/clear', async () => {
    await agent.clear();
    return { ok: true };
  });
  app.get('/api/agent/profile', async () => ({ profile: loadProfile(config.profileDir ?? null)?.info ?? null }));
  app.get('/api/agent/context', async () => ({ usage: await agent.contextUsage() }));

  const sessionIdSchema = { type: 'string', pattern: '^[A-Za-z0-9-]{1,100}$' } as const;
  app.get('/api/agent/sessions', async () => agent.listSessions());
  app.post<{ Body: { id: string } }>(
    '/api/agent/sessions/open',
    { schema: { body: { type: 'object', required: ['id'], properties: { id: sessionIdSchema } } } },
    async (req) => {
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
    async (req) => {
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

  app.get<{ Querystring: { path?: string } }>('/api/file', async (req, reply) => {
    const rel = req.query.path ?? '';
    const abs = await resolveInWorkspace(workspace.root, rel);
    const st = await stat(abs);
    if (!st.isFile() || !fileKind(abs)) throw new PathError('Không hỗ trợ loại file này', 415);
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
      if (!(await stat(abs)).isFile() || !fileKind(abs)) throw new PathError('Không hỗ trợ loại file này', 415);
      await (opts.openExternal ?? openExternal)(abs);
      return { ok: true };
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
