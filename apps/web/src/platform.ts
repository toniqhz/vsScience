/** Đang chạy trong app desktop (Electron) thay vì trình duyệt. */
export const IS_DESKTOP = /\bElectron\//.test(navigator.userAgent);

const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Tên trình quản lý file của máy, để ghi trên menu ("Hiện trong Finder"…). */
export const FILE_MANAGER = IS_MAC ? 'Finder' : /Windows/.test(navigator.userAgent) ? 'File Explorer' : 'trình quản lý file';
