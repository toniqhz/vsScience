import { createContext, useContext } from 'react';

/** Hành động của khung làm việc mà các khung con (tab diff…) cần gọi. */
export interface WorkbenchActions {
  openPath: (path: string) => void;
  openDiff: (path: string) => void;
}

export const WorkbenchContext = createContext<WorkbenchActions>({ openPath: () => {}, openDiff: () => {} });

export const useWorkbench = () => useContext(WorkbenchContext);
