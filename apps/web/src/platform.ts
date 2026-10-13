/** Đang chạy trong app desktop (Electron) thay vì trình duyệt. */
export const IS_DESKTOP = /\bElectron\//.test(navigator.userAgent);

export const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Phím tắt mở cửa sổ mới (app desktop). */
export const NEW_WINDOW_KEYS = IS_MAC ? '⌘⇧N' : 'Ctrl+Shift+N';

/** Tên trình quản lý file của máy, để ghi trên menu ("Hiện trong Finder"…). */
export const FILE_MANAGER = IS_MAC ? 'Finder' : /Windows/.test(navigator.userAgent) ? 'File Explorer' : 'trình quản lý file';
