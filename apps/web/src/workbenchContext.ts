import { createContext, useContext } from 'react';
import type { FindTarget } from '@ide/shared';

/** Hành động của khung làm việc mà các khung con (tab diff…) cần gọi. */
/** Bản lưu đang xem (khi mở diff của một file trong bản lưu cũ). */
export interface SnapshotRef {
  id: string;
  message: string;
}

export interface WorkbenchActions {
  /** Mở file (đường dẫn tương đối); `find`: tới đúng trang/chỗ khớp (link dẫn nguồn trong câu trả lời). */
  openPath: (path: string, find?: Omit<FindTarget, 'nonce'>) => void;
  /** Không có `snapshot`: so file hiện tại với bản lưu gần nhất. Có: so file trong bản đó với bản ngay trước. */
  openDiff: (path: string, snapshot?: SnapshotRef) => void;
}

export const WorkbenchContext = createContext<WorkbenchActions>({ openPath: () => {}, openDiff: () => {} });

export const useWorkbench = () => useContext(WorkbenchContext);
