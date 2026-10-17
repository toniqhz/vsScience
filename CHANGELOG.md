# Có gì mới trong VsScience

Mỗi phiên bản là một mục `## <phiên bản> — <ngày>`. App hiện các mục này sau khi cập nhật (từ bản người dùng đang dùng lên bản mới), và workflow phát hành chép mục của phiên bản vào trang Release trên GitHub. Viết cho người dùng: nói việc họ làm được, không nói chuyện kỹ thuật.

## 0.1.18 — 2026-10-17

- **Báo có bản mới**: app kiểm tra bản mới mỗi lần mở và mỗi ngày một lần. Có bản mới thì nút **Cài đặt** và mục **Có gì mới** có chấm vàng; bấm vào xem trước những gì mới kèm nút cập nhật.
- **Tài khoản Claude trong Cài đặt**: xem tài khoản đang đăng nhập (email, gói), **Đổi tài khoản** hoặc **Đăng xuất** ngay trong menu.
- **Đổi chế độ có hiệu lực ngay**: đang để "Hỏi trước" mà chuyển sang "Tự động" giữa lúc Claude làm, các bước sau không hỏi nữa và những yêu cầu sửa file trong thư mục đang chờ được cho phép luôn.

### Sửa lỗi trên Mac
- Bấm link dẫn chứng (tài liệu, trang) trong câu trả lời hay file tóm tắt giờ mở đúng file và trang với tài liệu có tên tiếng Việt.
- Thông báo: nếu macOS chặn thông báo của app, app dùng thông báo dự phòng (hiện dưới tên Script Editor) và đặt chấm đỏ trên biểu tượng Dock khi Claude xong việc hoặc cần bạn.

## 0.1.17 — 2026-10-14

- **Điều khiển từ xa (Remote Control)**: nút **Local / Remote Control** trong ô chat, cạnh tên model. Bật lên thì đoạn chat hiện trên **claude.ai/code** và **app Claude trên điện thoại** (mang tên đoạn chat, kèm lịch sử) để nhắn tiếp khi không ngồi ở máy — Claude vẫn làm việc trên máy tính, với tài liệu trong thư mục. Mỗi thư mục nhớ lựa chọn riêng.
- Trang **Có gì mới** tự hiện lần đầu mở app sau khi cập nhật (kể cả khi cập nhật từ bản 0.1.15 trở về trước).
- Biểu tượng đám mây ở thanh bên trái chỉ hiện khi máy đã kết nối tài khoản đám mây.

## 0.1.16 — 2026-10-14

### Đồng bộ thư mục với OneDrive
- Mục **Thay đổi** có biểu tượng đám mây: kết nối OneDrive rồi bật đồng bộ cho thư mục đang mở. Đám mây chuyển **màu vàng** khi đã bật.
- Mỗi khi có bản lưu mới, app tự đẩy phần đã đổi lên OneDrive (thư mục riêng `Ứng dụng/VsScience`, app không thấy các file khác của bạn).
- Sang máy khác: **Mở thư mục → Trên đám mây**, chọn thư mục rồi chọn chỗ đặt và bấm **Tải về**. Tài liệu, các đoạn chat với Claude và lịch sử bản lưu đều về theo.
- Hai máy cùng sửa: app tự gộp. File cả hai cùng sửa thì giữ bản máy này, bản máy kia lưu thành `tên (máy X)`.

### Tự lưu bản khi Claude xong việc
- Khi Claude làm xong một việc đủ lớn (tạo file mới hoặc sửa nhiều), app tự lưu một bản trong mục Thay đổi, mô tả là tóm tắt yêu cầu của bạn.
- Sửa lắt nhắt vài chữ, hoặc Claude còn đang hỏi lại bạn, thì chưa lưu. Bật/tắt trong **Cài đặt → Tự lưu khi Claude xong việc**.

### Dữ liệu đi theo thư mục
- Đoạn chat, bản lưu và cài đặt của thư mục giờ nằm ngay trong thư mục (thư mục ẩn `.vsscience`). Chép hay đổi tên thư mục vẫn mở tiếp được các đoạn chat cũ.
- App nhớ model và chế độ bạn chọn cho từng thư mục.

### Sửa lỗi
- Link tới trang tài liệu trong file ghi chú `.md` (ví dụ câu hỏi ôn tập Claude soạn) giờ mở đúng trang trong app, không còn mở ra trình duyệt.

## 0.1.15 — 2026-10-13

- **Thông báo** khi Claude làm xong, trả lời xong, hỏi lại bạn hoặc cần bạn cho phép — kể cả khi bạn đang ở app khác. Bấm vào thông báo để quay lại đúng cửa sổ. Bật/tắt trong **Cài đặt**.
- **Không để hai phiên Claude cùng sửa một file**: khi Claude đang làm trong một thư mục, cửa sổ khác mở cùng thư mục (hoặc thư mục cha/con) tạm khóa ô chat và có nút chuyển sang cửa sổ đang làm. Trong lúc Claude làm, không chuyển hay tạo phiên mới được (tránh dừng giữa chừng).
- Mở **cửa sổ mới** dễ hơn: menu **File → Cửa sổ mới…** trên Mac (⌘⇧N), mục trong menu Cài đặt và biểu tượng ở đầu cây thư mục.

## 0.1.14 — 2026-10-11

- **Tự cập nhật**: trên Windows app tự tải bản mới và cài khi khởi động lại; trên Mac app báo có bản mới kèm nút tải bộ cài.
- Nút bánh răng thành menu **Cài đặt**: Bối cảnh thư mục, Kiểm tra cập nhật.

## 0.1.13 — 2026-10-11

- Chế độ **Lười biếng**: Claude làm mà không hỏi gì cả, kể cả với file ngoài thư mục — nhưng vẫn luôn chặn việc rủi ro cao (xóa file ngoài thư mục, lệnh quản trị máy, đụng tới mật khẩu và thông tin đăng nhập).

## 0.1.12 — 2026-10-10

- **Nhiều cửa sổ**: mỗi cửa sổ một thư mục với phiên Claude riêng; bấm chuột phải biểu tượng app trên taskbar/Dock để mở cửa sổ mới.
- **Chuột phải trong cây thư mục**: xóa (vào Thùng rác), hiện trong File Explorer/Finder, mở trong cửa sổ mới.
- **Tìm kiếm**: tìm trong file đang xem (Ctrl+F) và tìm trong nội dung mọi file của thư mục — PDF, Word, Excel, PowerPoint, ghi chú; không cần gõ dấu. Bấm kết quả để mở đúng trang.
- **Connector khoa học** (Consensus, Scite, PubMed…): xem trạng thái, Claude ưu tiên dùng khi tra cứu và luôn ghi trích dẫn.
- **Viết và phản biện tài liệu**: lệnh /phan-bien, /kiem-tra-trich-dan, /danh-gia-de, /tong-quan; nhận xét trực tiếp vào file Word; xuất Word kèm tài liệu tham khảo; nhận dạng chữ (OCR) cho PDF ảnh quét; Claude dẫn nguồn bằng link bấm được tới đúng trang.
- **Bối cảnh thư mục**: ghi chủ đề, người đọc, chuẩn trích dẫn… để Claude viết đúng mà không phải dặn lại.

## 0.1.11 — 2026-10-10

- Sửa lỗi trên Windows: Claude không còn hỏi xin phép khi đọc PDF bằng công cụ có sẵn của app.

## 0.1.10 — 2026-10-10

- Sửa lỗi trên Mac: ở chế độ Tự động, Claude không còn hỏi lại khi làm việc với thư mục có tên tiếng Việt.
