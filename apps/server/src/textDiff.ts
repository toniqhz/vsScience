import type { FileChange } from '@ide/shared';

const CONTEXT = 2;
/** Quá ngưỡng này (số dòng cũ × mới) thì dùng diff nhanh (bỏ phần giống ở đầu/cuối) thay cho LCS. */
const LCS_LIMIT = 4_000_000;

type Op = { sign: ' ' | '-' | '+'; text: string; oldNo: number; newNo: number };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ sign: ' ', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      // Như git: dòng bỏ đứng trước dòng thêm.
      ops.push({ sign: '-', text: a[i]!, oldNo: i + 1, newNo: j });
      i++;
    } else {
      ops.push({ sign: '+', text: b[j]!, oldNo: i, newNo: j + 1 });
      j++;
    }
  }
  return ops;
}

function trimOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ sign: ' ', text: a[k]!, oldNo: k + 1, newNo: k + 1 });
  for (let k = pre; k < a.length - suf; k++) ops.push({ sign: '-', text: a[k]!, oldNo: k + 1, newNo: pre });
  for (let k = pre; k < b.length - suf; k++) ops.push({ sign: '+', text: b[k]!, oldNo: a.length - suf, newNo: k + 1 });
  for (let k = 0; k < suf; k++) {
    const oi = a.length - suf + k;
    const ni = b.length - suf + k;
    ops.push({ sign: ' ', text: a[oi]!, oldNo: oi + 1, newNo: ni + 1 });
  }
  return ops;
}

/** Diff hai danh sách dòng thành các đoạn (hunk) có vài dòng ngữ cảnh, như git diff. */
export function diffLines(a: string[], b: string[], path: string, kind: FileChange['kind']): FileChange {
  const ops = a.length * b.length > LCS_LIMIT ? trimOps(a, b) : lcsOps(a, b);
  const hunks: FileChange['hunks'] = [];
  let additions = 0;
  let deletions = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.sign === ' ') {
      k++;
      continue;
    }
    // Mở rộng đoạn thay đổi, gộp các thay đổi cách nhau ít hơn 2×CONTEXT dòng.
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.sign !== ' ') {
        end++;
        continue;
      }
      let next = end;
      while (next < ops.length && ops[next]!.sign === ' ') next++;
      if (next < ops.length && next - end <= CONTEXT * 2) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    const slice = ops.slice(start, stop);
    for (const op of slice) {
      if (op.sign === '+') additions++;
      else if (op.sign === '-') deletions++;
    }
    const first = slice[0]!;
    hunks.push({
      oldStart: first.sign === '+' ? first.oldNo + 1 : first.oldNo,
      newStart: first.sign === '-' ? first.newNo + 1 : first.newNo,
      lines: slice.map((op) => `${op.sign}${op.text}`),
    });
    start = stop;
    k = stop;
  }
  return { path, kind, additions, deletions, hunks };
}
