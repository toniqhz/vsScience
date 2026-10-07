import { tmpdir } from 'node:os';
import { query as sdkQuery, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PlanUsage, UsageWindow } from '@ide/shared';
import { cliEnv } from './claude-auth.js';

/** Bộ nhớ đệm: hạn mức đổi chậm, không cần hỏi lại liên tục. */
const CACHE_MS = 60_000;
const TIMEOUT_MS = 20_000;

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type RawUsage = {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: RawWindow;
    seven_day?: RawWindow;
    limits?: { kind?: string; percent?: number | null; resets_at?: string | null }[];
  } | null;
};

/** Hàm truy vấn tối thiểu cần dùng (test thay bằng bản giả). */
export type UsageQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: { skipBehaviors?: boolean }) => Promise<unknown>;
  close(): void;
} & AsyncIterable<unknown>;

function toWindow(w: RawWindow, fallback?: { percent?: number | null; resets_at?: string | null }): UsageWindow | null {
  const percent = w?.utilization ?? fallback?.percent;
  if (typeof percent !== 'number') return null;
  return { percent: Math.max(0, Math.min(100, percent)), resetsAt: w?.resets_at ?? fallback?.resets_at ?? null };
}

/** Chuyển dữ liệu /usage của SDK sang dạng app dùng. Trả về null khi gói không có hạn mức (API key…). */
export function toPlanUsage(raw: unknown, now = Date.now()): PlanUsage | null {
  const r = raw as RawUsage;
  if (!r?.rate_limits_available || !r.rate_limits) return null;
  const limits = r.rate_limits.limits ?? [];
  const session = toWindow(r.rate_limits.five_hour, limits.find((l) => l.kind === 'session'));
  const weekly = toWindow(r.rate_limits.seven_day, limits.find((l) => l.kind === 'weekly_all'));
  if (!session && !weekly) return null;
  return { plan: r.subscription_type ?? null, session, weekly, updatedAt: now };
}

/**
 * Lấy hạn mức gói Claude.ai qua Claude Code CLI: mở một phiên không gửi tin nhắn nào (không tốn
 * token, không tạo file hội thoại), hỏi dữ liệu /usage rồi đóng lại.
 *
 * Dùng API thử nghiệm của Agent SDK (tên hàm cố ý báo có thể đổi): mọi lỗi đều trả về null để
 * giao diện chỉ ẩn ô hạn mức, không làm hỏng app.
 */
export class PlanUsageMonitor {
  #cache: PlanUsage | null = null;
  #inflight: Promise<PlanUsage | null> | null = null;

  constructor(
    private readonly claudeBin: string,
    private readonly queryFn: UsageQueryFn = sdkQuery as unknown as UsageQueryFn,
  ) {}

  /** Hạn mức hiện tại; dùng bộ nhớ đệm trừ khi `force`. */
  get(force = false): Promise<PlanUsage | null> {
    if (!force && this.#cache && Date.now() - this.#cache.updatedAt < CACHE_MS) return Promise.resolve(this.#cache);
    this.#inflight ??= this.#fetch().finally(() => (this.#inflight = null));
    return this.#inflight;
  }

  async #fetch(): Promise<PlanUsage | null> {
    // Đầu vào không bao giờ có tin nhắn: CLI khởi động, trả lời yêu cầu điều khiển rồi bị đóng.
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const prompt = (async function* () {
      await stopped;
    })() as AsyncIterable<SDKUserMessage>;
    const q = this.queryFn({
      prompt,
      options: { cwd: tmpdir(), pathToClaudeCodeExecutable: this.claudeBin, env: cliEnv(), settingSources: [] },
    });
    // Phải đọc luồng tin nhắn để CLI chạy; bỏ qua nội dung.
    void (async () => {
      try {
        for await (const _ of q) {
          // không dùng
        }
      } catch {
        // CLI bị đóng
      }
    })();
    try {
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== 'function') return this.#cache;
      const raw = await Promise.race([
        fn.call(q, { skipBehaviors: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hết giờ')), TIMEOUT_MS)),
      ]);
      const usage = toPlanUsage(raw);
      if (usage) this.#cache = usage;
      return usage ?? this.#cache;
    } catch {
      return this.#cache;
    } finally {
      stop();
      q.close();
    }
  }
}
