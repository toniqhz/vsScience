# NOTES
## [2026-10-07] Cập nhật: rút kinh nghiệm từ Claude Cowork, chốt nguyên tắc "folder là trung tâm"

### Mục tiêu
Ghi lại nhận xét sau khi thử Claude Cowork và chuyển thành nguyên tắc thiết kế cho editor non-tech.

### Trạng thái hiện tại
Xong phần nguyên tắc thiết kế. Vẫn chưa có code. Kiến trúc ở mục 2026-10-07 trước đó giữ nguyên.

### Đã làm
- Người dùng (Toniqhz) tự cài và thử Claude Cowork.

### Kết quả chính
- Cowork khó dùng cho nhu cầu này: lấy cuộc hội thoại làm trung tâm, không lấy folder làm trung tâm, nên khó quản lý file, khó biết cái gì đã bị sửa, khó mở xem file. Đây là nhận xét của một người dùng, chưa thử với người dùng đích khác.

### Quyết định đã chốt
- Nguyên tắc thiết kế cốt lõi: folder là trung tâm, chat chỉ là công cụ bên cạnh (ngược với Cowork) — lý do: rút ra từ trải nghiệm thử Cowork. Cụ thể:
  1. Mở app là mở folder: màn hình đầu là danh sách folder gần đây (kiểu "Open Recent"). Lịch sử chat lưu theo từng folder, nằm ở panel phụ.
  2. Luôn thấy rõ cái gì đã thay đổi: file Claude vừa sửa/tạo có dấu màu trong cây thư mục; sau mỗi lượt Claude hiện thẻ tóm tắt ("Claude đã sửa 2 file, tạo 1 file"), bấm vào xem so sánh trước/sau, có nút Giữ và Hoàn tác. Cân nhắc chế độ "đề xuất": thay đổi chỉ ghi thật vào file khi người dùng bấm Giữ (kết hợp snapshot git và tracked changes trong Word).
  3. Xem file chỉ một cú bấm, chat bám theo file đang mở/đang chọn: bấm file là mở trong tab; chuột phải hoặc chọn nhiều file có lệnh "Hỏi Claude về các file này" và chạy skill trên file đó.

### File liên quan
- `NOTES.md` — mục 2026-10-07 trước đó chứa kiến trúc, quyết định công nghệ và lộ trình.

### Đã thử nhưng không dùng
- Dùng Claude Cowork thay cho việc tự xây app — lý do: hướng hội thoại, không hướng folder; khó quản lý và theo dõi thay đổi file.

### Vấn đề còn mở
- Chưa cho người dùng đích khác thử Cowork; chưa ai thử Claude Science.
- Chưa có danh sách cụ thể các thao tác bị vướng khi dùng Cowork.

### Bước tiếp theo
0. Ghi lại danh sách thao tác bị vướng khi dùng Cowork (ví dụ "muốn xem file vừa sửa phải làm mấy bước") thành mục "Tiêu chí MVP": mỗi thao tác phải làm được trong 1-2 cú bấm.
1. Sau đó tiếp tục từ bước 1 của mục 2026-10-07 trước (tạo monorepo `apps/server` + `apps/web`).

## [2026-10-07] Lên kiến trúc editor kiểu VS Code cho người dùng non-tech, tích hợp Claude

### Mục tiêu
Xây một app quản lý và làm việc với file, giao diện giống VS Code nhưng dành cho người không làm kỹ thuật: không hiện code, mở lên là dùng Claude (agent kiểu Claude Code) ngay, có quản lý phiên bản file ở local. Người dùng đích là người chuyên đọc sách, báo khoa học và soạn đề thi.

### Trạng thái hiện tại
Xong phần định hướng kiến trúc. Chưa có code. Chuẩn bị tạo thư mục dự án trên máy.

### Đã làm
- Phân tích nhu cầu theo 3 loại file người dùng dùng chính: Word, Excel, PDF.
- So sánh các cách triển khai: fork VS Code, Tauri, Electron, chạy thuần trong trình duyệt, server local + giao diện web.
- Tìm hiểu Claude Science (Anthropic, beta từ 2026-06-30) để đối chiếu kiến trúc.

### Kết quả chính
- Vai trò từng loại file (cơ sở cho thiết kế):
  - PDF = đầu vào, chỉ đọc. Trọng tâm: trích dẫn kèm số trang, bấm vào thì nhảy đến đúng trang và highlight (pdf.js). Sách scan cần OCR (Tesseract hoặc OCRmyPDF). Ghi chú và highlight lưu riêng thành JSON, không sửa file gốc.
  - Word = sản phẩm chính (đề thi). Hiển thị bằng LibreOffice headless chuyển docx sang PDF để giữ đúng công thức (OMML), vì mammoth làm mất công thức. Claude sửa bằng tracked changes, không ghi đè. Hỗ trợ nạp file .docx mẫu đề của trường. So sánh phiên bản theo đoạn văn.
  - Excel = ngân hàng câu hỏi và bảng điểm. Cột cố định: nội dung, đáp án, mức độ, chương, trang nguồn. Đề Word được sinh từ bảng này. Sửa bằng openpyxl để giữ công thức. So sánh phiên bản theo ô.
- Claude Science (đã kiểm chứng qua thông báo của Anthropic và các bài viết):
  - Là app chạy local trên macOS/Linux, có thể chạy như server (`claude-science serve`) và truy cập qua trình duyệt, giống mô hình Jupyter. Chạy được trên máy từ xa qua SSH/HPC. Windows chưa có bản riêng.
  - Nhắm đến khoa học tính toán (sinh học, hóa học, chạy code), nên quá kỹ thuật với người dùng đích của dự án này. Đây là khoảng trống dự án có thể lấp.
  - Anthropic không công bố stack bên trong.

### Quyết định đã chốt
- Kiến trúc: server local (Node) + giao diện web (React), về sau bọc thêm Electron để có app desktop — lý do: giống mô hình Claude Science/Jupyter, dễ phát triển và debug, dùng chung code giao diện cho cả trình duyệt và desktop.
- Ngôn ngữ: TypeScript cho cả server và web — lý do: Claude Agent SDK, isomorphic-git, pdf.js, SheetJS đều thuộc hệ JS/TS, một người làm được.
- Mượn bố cục VS Code (thanh icon, cây thư mục, tab, panel chat bên phải, thanh trạng thái), không mượn mã nguồn VS Code.
- Agent: Claude Agent SDK (TypeScript) chạy ở server, không chạy ở trình duyệt. Giới hạn `cwd` trong thư mục dự án, hạn chế hoặc tắt tool bash.
- Xác thực: dùng API key (Claude Platform) giữ ở server — lý do: sản phẩm bên thứ ba không nên cho đăng nhập bằng tài khoản Claude.ai. Cần đọc điều khoản trên docs.claude.com trước khi phát hành.
- Quản lý version: git chạy ngầm (isomorphic-git), người dùng chỉ thấy khái niệm "bản lưu". Tự snapshot trước và sau mỗi lượt Claude sửa file, có nút "Hoàn tác thay đổi của Claude", timeline theo file, nút khôi phục và so sánh. Không có branch, merge hay commit message (tên snapshot lấy từ câu lệnh người dùng).
- Trộn mã đề (A/B/C/D), đảo đáp án, xuất đáp án làm bằng script cố định, không dùng LLM — lý do: cần chính xác 100% và lặp lại được.
- Quy trình hay dùng đóng gói thành Agent Skills, mỗi skill là một nút trên giao diện (ví dụ: soạn N câu trắc nghiệm từ chương theo mẫu trường, tóm tắt bài báo kèm số trang, trộn 4 mã đề).
- Bảo mật server: chỉ nghe ở `127.0.0.1`, có token truy cập.

### File liên quan
- `NOTES.md` — file bàn giao này. Chưa có file code nào.

### Đã thử nhưng không dùng
- Fork VS Code (Code-OSS) — lý do: quá nặng, tốn công gỡ phần không cần hơn là xây phần cần.
- Tauri — lý do: phải viết thêm Rust và quản lý sidecar Python, phức tạp hơn mà không đáng với một người làm.
- Electron ngay từ đầu (thay vì server + web) — lý do: chuyển sang server + web để phát triển nhanh hơn; Electron để dành cho bước đóng gói sau.
- Chạy thuần trong trình duyệt bằng File System Access API — lý do: Agent SDK cần Node; API key không đặt được trong trình duyệt; Python và LibreOffice bản WASM quá nặng; Firefox/Safari không hỗ trợ.

### Vấn đề còn mở
- Người dùng chạy app trên chính máy của họ, hay đặt một máy chung cho nhiều người truy cập qua trình duyệt? (Ảnh hưởng đến xác thực, phân quyền, nơi lưu API key.)
- Hệ điều hành mục tiêu của người dùng cuối (Windows chiếm đa số thì cần tính cách đóng gói Python + LibreOffice cho Windows).
- Tên dự án chưa đặt.
- Chưa cho người dùng thật thử Claude Cowork và Claude Science để xác định chính xác họ còn thiếu gì.

### Bước tiếp theo
1. Tạo monorepo (pnpm workspaces) gồm `apps/server` (Node + Fastify hoặc Express + WebSocket) và `apps/web` (Vite + React + TypeScript).
2. Server: API đọc cây thư mục, đọc file, theo dõi thay đổi bằng `chokidar`; chỉ nghe ở 127.0.0.1, có token.
3. Web: dựng bố cục kiểu VS Code bằng `allotment` (chia vùng), `dockview` (tab), `@vscode/codicons` (icon).
4. Web: cây thư mục bằng `react-arborist`, chỉ hiện Word, Excel, PDF và thư mục.
5. Web: trình xem PDF bằng pdf.js, mở trong tab. Mốc tuần đầu: mở được thư mục, thấy cây file, xem được PDF.
6. Sau đó: ghép Claude Agent SDK ở server, stream qua WebSocket sang panel chat; rồi gắn isomorphic-git snapshot; rồi Excel (SheetJS), Word (LibreOffice).
7. Luồng MVP ưu tiên: PDF → câu hỏi có số trang → Excel ngân hàng câu hỏi → đề Word theo mẫu.

### Bối cảnh cần nhớ
- Người dùng cuối không phải developer: không hiện code, không thuật ngữ git, tiến trình agent hiển thị dạng thân thiện ("Đang sửa file Báo cáo.docx…").
- Đóng gói cuối cùng sẽ nặng (vài trăm MB) vì kèm Python (openpyxl, python-docx, PyMuPDF) và LibreOffice. Nên thử đóng gói sớm một lần.
- Chi phí token: chỉ đưa vào ngữ cảnh các file liên quan, tránh nạp nguyên tài liệu lớn.
- Mã nguồn mở để tham khảo kiến trúc tương tự Claude Science:
  - https://github.com/ai4s-research/open-science (Tauri 2 + React, có chế độ server không cửa sổ dùng chung giao diện web)
  - https://github.com/aipoch/open-science (Electron + npm)
- Thông báo Claude Science: https://www.anthropic.com/news/claude-science-ai-workbench