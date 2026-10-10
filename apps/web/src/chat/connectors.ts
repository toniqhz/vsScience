/**
 * Tên dễ đọc cho công cụ của connector (MCP): "mcp__claude_ai_Consensus__search" → "Tìm trên Consensus".
 * Tên server có thể chứa "_" đơn; phần server và tên công cụ ngăn bằng "__".
 */

const VERBS: [RegExp, string, string][] = [
  // [động từ đầu tên công cụ, cách nói, giới từ trước tên connector]
  [/^(search|find|lookup)$/, 'Tìm', 'trên'],
  [/^(query|ask)$/, 'Tra cứu', 'trên'],
  [/^(get|fetch|read|retrieve|load|download)$/, 'Lấy', 'từ'],
  [/^(list|browse)$/, 'Xem danh sách', 'trên'],
  [/^(create|add|new|generate|make)$/, 'Tạo', 'trên'],
  [/^(update|edit|modify|set)$/, 'Cập nhật', 'trên'],
  [/^(delete|remove)$/, 'Xóa', 'trên'],
  [/^(export)$/, 'Xuất', 'từ'],
  [/^(predict|run|analyze|analyse|compute)$/, 'Chạy', 'trên'],
];

/** "claude_ai_Wiley_Scholar_Gateway" → "Wiley Scholar Gateway". */
export function connectorName(server: string): string {
  return server.replace(/^claude_ai_/, '').replace(/_/g, ' ').trim() || server;
}

export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: connectorName(m[1]!), tool: m[2]! } : null;
}

/** Tiêu đề cho dòng công cụ / ô xin quyền; null nếu không phải công cụ connector. */
export function connectorTitle(name: string): string | null {
  const p = parseMcpTool(name);
  if (!p) return null;
  const words = p.tool.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\s-]+/).filter(Boolean);
  const verb = VERBS.find(([re]) => re.test(words[0] ?? ''));
  if (!verb) return `${p.server}: ${words.join(' ')}`;
  const rest = words.slice(1).join(' ');
  return `${verb[1]}${rest ? ` ${rest}` : ''} ${verb[2]} ${p.server}`;
}

const MAIN_ARGS = ['query', 'q', 'search', 'search_query', 'question', 'prompt', 'term', 'keywords', 'title', 'name', 'doi', 'id', 'url'];

/** Tham số chính để hiện kèm (từ khóa tìm, tên, DOI…). */
export function connectorDetail(input: Record<string, unknown>): string {
  for (const k of MAIN_ARGS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? first.trim() : '';
}
