import { useCallback, useState } from 'react';

/** Theo dõi kích thước một phần tử (cho các component cần width/height bằng số như react-arborist). */
export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [observer] = useState(
    () =>
      new ResizeObserver(([entry]) => {
        if (!entry) return;
        const { width, height } = entry.contentRect;
        // Phần tử bị ẩn (display:none) báo kích thước 0: giữ kích thước cũ để không gỡ nội dung.
        if (width === 0 && height === 0) return;
        setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
      }),
  );
  const ref = useCallback(
    (el: T | null) => {
      observer.disconnect();
      if (el) observer.observe(el);
    },
    [observer],
  );
  return [ref, size] as const;
}
