// Model và mức suy nghĩ (effort) cho bộ chọn model.
// Kích thước ngữ cảnh và effort mặc định theo tài liệu Claude API (09/2026).

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Thấp',
  medium: 'Vừa',
  high: 'Cao',
  xhigh: 'Rất cao',
  max: 'Tối đa',
};

const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelInfo {
  id: string;
  name: string;
  note: string;
  contextWindow: number;
  /** Rỗng nếu model không hỗ trợ effort. */
  efforts: Effort[];
  defaultEffort: Effort | null;
}

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    note: 'Mặc định, giỏi cho hầu hết việc',
    contextWindow: 1_000_000,
    efforts: ALL_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    note: 'Nhanh hơn, rẻ hơn',
    contextWindow: 1_000_000,
    efforts: ALL_EFFORTS,
    defaultEffort: 'high',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    note: 'Nhanh nhất, cho việc đơn giản',
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: 'claude-fable-5-1',
    name: 'Fable 5.1',
    note: 'Mạnh nhất, chi phí cao',
    contextWindow: 1_000_000,
    efforts: ALL_EFFORTS,
    defaultEffort: 'high',
  },
];

export const DEFAULT_MODEL = MODELS[0]!;

export function findModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? DEFAULT_MODEL;
}

/** Chế độ quyền, giống Claude Code: hỏi trước khi sửa / tự sửa / chỉ lập kế hoạch. */
export type PermissionMode = 'ask' | 'auto' | 'plan';

export const MODES: { id: PermissionMode; label: string; short: string; icon: string; description: string }[] = [
  {
    id: 'ask',
    label: 'Hỏi trước khi sửa',
    short: 'Hỏi trước',
    icon: 'codicon-shield',
    description: 'Claude hỏi bạn trước mỗi lần sửa file.',
  },
  {
    id: 'auto',
    label: 'Tự động sửa',
    short: 'Tự động',
    icon: 'codicon-zap',
    description: 'Claude tự chạy lệnh và sửa file trong thư mục đang mở; đụng tới file bên ngoài thì hỏi bạn.',
  },
  {
    id: 'plan',
    label: 'Lập kế hoạch',
    short: 'Kế hoạch',
    icon: 'codicon-list-unordered',
    description: 'Claude chỉ đọc và đề xuất kế hoạch, không sửa file.',
  },
];

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(n);
}
