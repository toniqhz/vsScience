/** Bỏ dấu tiếng Việt để tìm "de thi" vẫn ra "Đề thi". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** Thời gian tương đối kiểu "5 phút trước". */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'vừa xong';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.round(h / 24);
  if (d === 1) return 'hôm qua';
  if (d < 7) return `${d} ngày trước`;
  return new Date(ms).toLocaleDateString('vi-VN');
}

/** Cỡ file dễ đọc: 1,2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('vi-VN', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}
