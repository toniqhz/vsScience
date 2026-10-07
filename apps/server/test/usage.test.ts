import { describe, expect, it } from 'vitest';
import { PlanUsageMonitor, toPlanUsage, type UsageQueryFn } from '../src/usage.js';

const RAW = {
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 65, resets_at: '2026-10-07T12:49:59Z' },
    seven_day: { utilization: 22, resets_at: '2026-10-14T01:59:59Z' },
  },
};

/** CLI giả: đếm số lần mở phiên, trả dữ liệu /usage cho trước. */
function fakeQuery(answer: () => unknown) {
  const calls = { opened: 0, closed: 0 };
  const fn: UsageQueryFn = () => {
    calls.opened++;
    let closed = false;
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => answer(),
      close: () => {
        closed = true;
        calls.closed++;
      },
      async *[Symbol.asyncIterator]() {
        while (!closed) await new Promise((r) => setTimeout(r, 5));
      },
    };
  };
  return { fn, calls };
}

describe('hạn mức gói Claude.ai', () => {
  it('đọc phiên 5 giờ và tuần', () => {
    expect(toPlanUsage(RAW, 1)).toEqual({
      plan: 'pro',
      session: { percent: 65, resetsAt: '2026-10-07T12:49:59Z' },
      weekly: { percent: 22, resetsAt: '2026-10-14T01:59:59Z' },
      updatedAt: 1,
    });
  });

  it('dùng mảng limits khi thiếu five_hour/seven_day; không có hạn mức (API key) thì null', () => {
    const viaLimits = toPlanUsage({
      rate_limits_available: true,
      rate_limits: { limits: [{ kind: 'session', percent: 40, resets_at: null }, { kind: 'weekly_all', percent: 130, resets_at: null }] },
    });
    expect(viaLimits).toMatchObject({ session: { percent: 40 }, weekly: { percent: 100 } });
    expect(toPlanUsage({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(toPlanUsage(undefined)).toBeNull();
  });

  it('gom lần gọi trùng, dùng bộ nhớ đệm, luôn đóng CLI', async () => {
    const { fn, calls } = fakeQuery(() => RAW);
    const m = new PlanUsageMonitor('/khong/can', fn);
    const [a, b] = await Promise.all([m.get(), m.get()]);
    expect(a).toEqual(b);
    expect(a?.session?.percent).toBe(65);
    await m.get();
    expect(calls).toEqual({ opened: 1, closed: 1 });
    await m.get(true);
    expect(calls).toEqual({ opened: 2, closed: 2 });
  });

  it('API thử nghiệm lỗi hoặc không còn: trả số liệu cũ (hoặc null), không ném lỗi', async () => {
    let fail = false;
    const { fn } = fakeQuery(() => {
      if (fail) throw new Error('đổi API');
      return RAW;
    });
    const m = new PlanUsageMonitor('/khong/can', fn);
    expect((await m.get())?.weekly?.percent).toBe(22);
    fail = true;
    expect((await m.get(true))?.weekly?.percent).toBe(22);
    const gone: UsageQueryFn = () => ({ close() {}, async *[Symbol.asyncIterator]() {} });
    expect(await new PlanUsageMonitor('/khong/can', gone).get()).toBeNull();
  });
});
