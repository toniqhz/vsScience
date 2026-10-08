import type { Item } from './agentStore';

export type StepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: StepStatus;
  /** Mục trong hội thoại ghi nhận thay đổi gần nhất của bước này (để cuộn tới). */
  key: string;
}

const STATUSES: StepStatus[] = ['pending', 'in_progress', 'completed'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Dựng kế hoạch hiện tại từ các lần Claude dùng công cụ ghi việc (TaskCreate / TaskUpdate / TaskList,
 * hoặc TodoWrite ở bản cũ). Hội thoại phát lại từ server khi tải trang, nên kế hoạch cũng giữ nguyên.
 */
export function derivePlan(items: Item[]): PlanStep[] {
  const steps = new Map<string, PlanStep>();
  let created = 0;
  for (const it of items) {
    if (it.type !== 'tool' || it.result?.isError) continue;
    const { name, input, key } = it;
    const output = it.result?.output ?? '';
    if (name === 'TaskCreate') {
      // Kết quả dạng "Task #3 created successfully: …"; khi chưa có kết quả thì đoán theo thứ tự tạo.
      created++;
      const id = /#(\d+)/.exec(output)?.[1] ?? String(created);
      steps.set(id, {
        id,
        subject: str(input.subject),
        description: str(input.description),
        activeForm: str(input.activeForm) || undefined,
        status: 'pending',
        key,
      });
    } else if (name === 'TaskUpdate') {
      const id = str(input.taskId).replace(/^#/, '');
      const step = steps.get(id);
      if (!step) continue;
      if (input.status === 'deleted') {
        steps.delete(id);
        continue;
      }
      steps.set(id, {
        ...step,
        subject: str(input.subject) || step.subject,
        description: str(input.description) || step.description,
        activeForm: str(input.activeForm) || step.activeForm,
        status: STATUSES.includes(input.status as StepStatus) ? (input.status as StepStatus) : step.status,
        key,
      });
    } else if (name === 'TaskList' && output) {
      // Đồng bộ trạng thái theo danh sách Claude vừa xem (dòng dạng "#2 [completed] …").
      for (const m of output.matchAll(/#(\d+)\s*\[(\w+)\]/g)) {
        const step = steps.get(m[1]!);
        if (step && STATUSES.includes(m[2] as StepStatus)) step.status = m[2] as StepStatus;
      }
    } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      // Mỗi lần ghi là cả danh sách. Bước nào không đổi trạng thái thì giữ chỗ cập nhật cũ,
      // để bấm vào bước đó cuộn tới đúng lúc nó được thêm hoặc đổi trạng thái.
      const before = new Map([...steps.values()].map((st) => [st.subject, st]));
      steps.clear();
      (input.todos as { content?: string; status?: string; activeForm?: string }[]).forEach((t, i) => {
        const id = String(i + 1);
        const subject = str(t.content);
        const status = STATUSES.includes(t.status as StepStatus) ? (t.status as StepStatus) : 'pending';
        const prev = before.get(subject);
        steps.set(id, {
          id,
          subject,
          description: '',
          activeForm: str(t.activeForm) || undefined,
          status,
          key: prev && prev.status === status ? prev.key : key,
        });
      });
    }
  }
  return [...steps.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

/** Mục ghi kế hoạch gần nhất: đổi mỗi khi Claude thêm, sửa hay đánh dấu bước (để biết kế hoạch đã thay đổi). */
export function planVersion(items: Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'tool' && PLAN_TOOLS.has(it.name) && it.name !== 'TaskList' && it.name !== 'TaskGet' && !it.result?.isError) return it.key;
  }
  return null;
}

export const PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);
