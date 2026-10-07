import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PackInfo } from '@ide/shared';
import { PathError } from './paths.js';
import { INSTALLED_MARKER, withRuntime } from './runtime.js';

type Manifest = Pick<PackInfo, 'id' | 'title' | 'packages' | 'downloadBytes' | 'installedBytes'>;

/**
 * Gói tùy chọn: thư viện Python nặng không nằm trong bộ cài, người dùng chọn cài khi cần.
 * Danh sách file và SHA256 được khóa lúc build (<python>/packs/<id>.lock); pip cài với
 * --require-hashes nên chỉ nhận đúng các file đó. Cài vào thư mục tạm rồi đổi tên, để không bao
 * giờ có gói cài dở.
 */
export class PackManager {
  #running = new Map<string, PackInfo>();
  #errors = new Map<string, string>();

  constructor(
    /** Thư mục Python đi kèm app (có packs/*.json, *.lock); null khi chạy dev. */
    private readonly pythonHome: string | null,
    /** Nơi cài gói (thư mục dữ liệu của app, ghi được). */
    private readonly packsDir: string | null,
    private readonly emit: (pack: PackInfo) => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  #manifests(): Manifest[] {
    if (!this.pythonHome || !this.packsDir) return [];
    const dir = path.join(this.pythonHome, 'packs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Manifest);
  }

  #lockFile(id: string) {
    return path.join(this.pythonHome!, 'packs', `${id}.lock`);
  }

  /** Mã của file khóa: gói đã cài chỉ còn hợp lệ nếu cài từ đúng file khóa của bản app này. */
  #lockHash(id: string) {
    return createHash('sha256').update(readFileSync(this.#lockFile(id))).digest('hex');
  }

  #info(m: Manifest): PackInfo {
    const running = this.#running.get(m.id);
    if (running) return running;
    const marker = path.join(this.packsDir!, m.id, INSTALLED_MARKER);
    const installed = existsSync(marker) && readFileSync(marker, 'utf8').trim() === this.#lockHash(m.id);
    const error = this.#errors.get(m.id);
    return { ...m, state: installed ? 'installed' : error ? 'error' : 'missing', ...(error ? { message: error } : {}) };
  }

  list(): PackInfo[] {
    return this.#manifests().map((m) => this.#info(m));
  }

  /** Bắt đầu cài (chạy nền); tiến độ báo qua `emit`. */
  install(id: string): PackInfo {
    const m = this.#manifests().find((x) => x.id === id);
    if (!m || !this.pythonHome || !this.packsDir) throw new PathError('Không có gói này', 404);
    const current = this.#info(m);
    if (current.state === 'installing' || current.state === 'installed') return current;
    const total = readFileSync(this.#lockFile(id), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    const update = (patch: Partial<PackInfo>) => {
      const next = { ...(this.#running.get(id) ?? { ...m, state: 'installing' as const }), ...patch };
      this.#running.set(id, next);
      this.emit(next);
    };
    this.#errors.delete(id);
    update({ state: 'installing', progress: { done: 0, total }, message: 'Đang chuẩn bị…' });
    void this.#run(m, total, update).then(
      () => {
        this.#running.delete(id);
        this.emit(this.#info(m));
      },
      (err: Error) => {
        this.#running.delete(id);
        this.#errors.set(id, err.message);
        this.emit(this.#info(m));
      },
    );
    return this.#running.get(id)!;
  }

  async #run(m: Manifest, total: number, update: (p: Partial<PackInfo>) => void) {
    const final = path.join(this.packsDir!, m.id);
    const tmp = path.join(this.packsDir!, `.${m.id}-dang-cai`);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const python = this.platform === 'win32' ? path.join(this.pythonHome!, 'python.exe') : path.join(this.pythonHome!, 'bin', 'python3');
    const args = [
      '-m', 'pip', 'install',
      '--disable-pip-version-check', '--no-input', '--progress-bar', 'off', '--no-compile',
      '--only-binary=:all:', '--no-deps', '--require-hashes',
      '--target', tmp, '-r', this.#lockFile(m.id),
    ];
    let done = 0;
    let lastLines: string[] = [];
    try {
      await this.#pip(python, args, total, update, (l) => (lastLines = [...lastLines.slice(-8), l]), () => ++done);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      const tail = lastLines.join('\n');
      throw new Error(
        /hash/i.test(tail)
          ? 'File tải về không khớp mã kiểm tra (có thể bị thay đổi trên đường truyền). Đã hủy cài đặt.'
          : /connection|network|resolve|timed out|proxy|ssl/i.test(tail)
            ? 'Không tải được từ PyPI. Kiểm tra kết nối mạng rồi thử lại.'
            : `Cài không thành công. ${lastLines.at(-1) ?? (err as Error).message}`.trim(),
      );
    }
    await writeFile(path.join(tmp, INSTALLED_MARKER), this.#lockHash(m.id));
    await rm(final, { recursive: true, force: true });
    await rename(tmp, final);
  }

  #pip(
    python: string,
    args: string[],
    total: number,
    update: (p: Partial<PackInfo>) => void,
    remember: (line: string) => void,
    next: () => number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(python, args, { env: withRuntime({ ...process.env }, this.pythonHome, this.platform, []), stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = (buf: Buffer) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          remember(line);
          const collecting = /^Collecting (\S+)/.exec(line);
          if (collecting) {
            const done = next();
            update({ progress: { done, total }, message: `Đang tải ${collecting[1]!.split('==')[0]} (${done}/${total})` });
          } else if (/^Installing collected packages/.test(line)) {
            update({ progress: { done: total, total }, message: 'Đang cài đặt…' });
          }
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pip thoát với mã ${code}`))));
    });
  }
}
