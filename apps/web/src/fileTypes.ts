import type { FileKind } from '@ide/shared';

export const FILE_KIND_META: Record<FileKind, { icon: string; label: string }> = {
  pdf: { icon: 'codicon-file-pdf', label: 'PDF' },
  word: { icon: 'codicon-file-text', label: 'Word' },
  excel: { icon: 'codicon-table', label: 'Excel' },
  powerpoint: { icon: 'codicon-preview', label: 'PowerPoint' },
  markdown: { icon: 'codicon-markdown', label: 'Ghi chú' },
  text: { icon: 'codicon-note', label: 'Văn bản' },
  html: { icon: 'codicon-globe', label: 'Trang HTML' },
  image: { icon: 'codicon-file-media', label: 'Ảnh' },
  other: { icon: 'codicon-file', label: 'File' },
};

const KIND_BY_EXT: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'word',
  doc: 'word',
  xlsx: 'excel',
  xlsm: 'excel',
  xls: 'excel',
  csv: 'excel',
  pptx: 'powerpoint',
  ppt: 'powerpoint',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  json: 'text',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
};

/** Loại file theo đuôi (khớp với cách server phân loại cho các loại thường gặp). */
export function kindOfPath(path: string): FileKind {
  return KIND_BY_EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'other';
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
