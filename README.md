# VsScience

App quản lý và làm việc với file Word, Excel, PDF có trợ lý Claude, giao diện kiểu VS Code cho người không làm kỹ thuật. Xem bối cảnh và quyết định kiến trúc trong `NOTES.md`.

## Cấu trúc

- `apps/server` — Node + Fastify. API cây thư mục, đọc file, WebSocket báo thay đổi (chokidar). Chỉ nghe ở `127.0.0.1`, cần token.
- `apps/web` — Vite + React. Bố cục allotment + dockview, cây file react-arborist, xem PDF bằng pdf.js.
- `packages/shared` — kiểu dữ liệu dùng chung (chỉ type).

## Chạy khi phát triển

Cần Node ≥ 20.19 và pnpm (`corepack enable pnpm`).

```sh
pnpm install
pnpm dev                                  # server :4317 + Vite :5173
IDE_WORKSPACE=~/Tài-liệu pnpm dev         # chọn thư mục làm việc khác
```

Mở đường link server in ra (`http://127.0.0.1:5173/?token=…`). Token lưu ở `~/.config/ide/token`, giữ nguyên qua các lần khởi động.

Mặc định thư mục làm việc là `demo-workspace/` (không đưa vào git).

## Đăng nhập Claude

App dùng tài khoản Claude (gói Pro/Max) qua Claude Code CLI đi kèm Agent SDK, giống plugin VS Code: bấm vào ô chat → "Đăng nhập bằng tài khoản Claude" → cấp quyền trên claude.ai. Phiên đăng nhập lưu ở `~/.claude/` và dùng chung với Claude Code trên máy (đã đăng nhập plugin VS Code thì app dùng được ngay). `ANTHROPIC_API_KEY` bị bỏ qua khi chạy CLI để luôn dùng gói thuê bao.

App chỉ dành cho dùng cá nhân trên máy mình: Anthropic không cho sản phẩm bên thứ ba cung cấp đăng nhập Claude.ai cho người khác nếu chưa được duyệt.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `IDE_WORKSPACE` | Thư mục làm việc |
| `IDE_PORT` | Cổng server (mặc định 4317) |
| `IDE_TOKEN` | Ghi đè token |
| `IDE_POLLING=1` | Theo dõi file bằng polling — cần khi thư mục nằm trên `/mnt/c` (WSL) hoặc ổ mạng |
| `IDE_CLAUDE_BIN` | Dùng Claude Code CLI khác thay cho bản đi kèm Agent SDK |
| `IDE_CLAUDE_PROFILE` | Thư mục hồ sơ Claude khác (mặc định `claude-code-khoa-hoc/claude-code-khoa-hoc/`); để rỗng để tắt |

## Quyền của Claude

- **Hỏi trước:** Claude hỏi trước mỗi lần sửa file và mỗi lệnh.
- **Tự động:** Claude tự chạy lệnh và sửa file, miễn là chỉ trong thư mục đang mở (cộng thư mục scratchpad
  Claude Code cấp cho mỗi phiên). Thao tác đụng tới file bên ngoài thì hỏi lại, thẻ xin quyền ghi rõ các đường dẫn đó.
  Kiểm tra theo nội dung câu lệnh và script Claude chạy (`apps/server/src/folderGuard.ts`), không phải sandbox
  của hệ điều hành: đường dẫn ghép lúc chạy (qua biến môi trường lạ…) có thể lọt.
- **Lập kế hoạch:** Claude chỉ đọc và đề xuất, kế hoạch luôn cần bạn duyệt.

## Hồ sơ Claude (khoa học)

Mỗi phiên Claude tự nạp hồ sơ trong `claude-code-khoa-hoc/claude-code-khoa-hoc/`:

- `.claude/output-styles/*.md`: giọng trả lời (hiện là "Nhà khoa học"), ghép vào system prompt.
- `CLAUDE.md`: quy trình lập luận khoa học, phản biện trước khi báo cáo, cấu trúc báo cáo. Ghép vào system prompt.
- `.claude/agents/*.md`: subagent (hiện là `reviewer`), đăng ký qua tùy chọn `agents` của Agent SDK.

Server thêm một đoạn điều chỉnh cho app (`apps/server/src/profile.ts`): không dùng git trong thư mục làm việc
(thay bằng nhắc bấm "Lưu bản"), chỉ dùng cấu trúc `data/ analysis/ …` khi thư mục đã có, việc đơn giản không cần quy trình đầy đủ.
Sửa file trong hồ sơ là có hiệu lực ở phiên Claude tiếp theo. CLAUDE.md riêng trong thư mục làm việc vẫn được nạp như Claude Code.
Tác vụ nền bị tắt (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`) để phản biện chạy xong trước khi Claude trả lời.

## Kiểm tra

```sh
pnpm typecheck
pnpm test        # test server: token, Host, chặn đường dẫn ra ngoài, lọc cây
pnpm build && pnpm start   # server phục vụ luôn bản build của web ở :4317
```

## App desktop (Windows, macOS)

App Electron trong `apps/desktop/`: chạy server ngay trong app, mở cửa sổ trỏ tới giao diện.
Đi kèm Claude Code CLI đúng hệ điều hành và hồ sơ Claude khoa học. Dữ liệu app (token, bản lưu)
nằm trong thư mục dữ liệu của app; lần đầu mở thư mục Tài liệu (Documents).

```bash
pnpm --filter @ide/desktop dist:win   # Windows: trên Linux/WSL ra bản .zip; trên Windows ra thêm bộ cài .exe
pnpm --filter @ide/desktop dist:mac   # macOS: chỉ build được trên máy Mac (.dmg + .zip, arm64 và x64)
```

Kết quả nằm trong `apps/desktop/release/`.

App chạy được trên máy chưa cài gì:

- **Python 3.12 portable** (python-build-standalone, bản phát hành ghim trong `apps/desktop/scripts/fetch-python.mjs`,
  kiểm SHA256) kèm thư viện lõi trong `apps/desktop/python-requirements.txt`: python-docx, openpyxl, xlrd, PyMuPDF.
  App đưa Python này lên đầu PATH của Claude, bật UTF-8 (tiếng Việt trên Windows) và báo cho Claude thư viện có sẵn.
- **Gói tùy chọn "Phân tích số liệu"** (`apps/desktop/python-extras.txt`: numpy, pandas, scipy, matplotlib) không nằm
  trong bộ cài. Lần đầu mở app hỏi người dùng có cài không (nêu mục đích, dung lượng); cài sau bằng lệnh `/cai-goi`.
  Lúc build, script khóa từng file wheel kèm SHA256 cho từng nền tảng (`resources/python/packs/data.lock`); app cài bằng
  `pip --require-hashes` vào thư mục dữ liệu của app, rồi đưa vào `PYTHONPATH` của Claude.
- **Windows không cần Git:** không có Git Bash thì Claude Code dùng công cụ PowerShell có sẵn.
- **Claude Code CLI** đúng hệ điều hành. Workflow `.github/workflows/desktop.yml` build cả hai trên GitHub Actions.

Kiểm tra bản đóng gói mà không mở cửa sổ (dùng thư mục tạm, không đụng dữ liệu thật):

```bash
VsScience.exe --smoke-test=C:\đường\dẫn\ket-qua.json
```

Chạy từ terminal của VS Code thì bỏ biến `ELECTRON_RUN_AS_NODE` trước, nếu không Electron chạy như Node.

Chưa ký số: Windows SmartScreen sẽ cảnh báo (bấm "More info" → "Run anyway"); macOS chặn app tải từ mạng
(chuột phải → Open, hoặc `xattr -dr com.apple.quarantine "/Applications/VsScience.app"`).

