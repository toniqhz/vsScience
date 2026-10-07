import type { FileKind } from '@ide/shared';

export const FILE_KIND_META: Record<FileKind, { icon: string; label: string }> = {
  pdf: { icon: 'codicon-file-pdf', label: 'PDF' },
  word: { icon: 'codicon-file-text', label: 'Word' },
  excel: { icon: 'codicon-table', label: 'Excel' },
};

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
