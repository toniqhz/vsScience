# Bối cảnh project

<!-- Điền phần này cho từng project. Càng cụ thể, Claude càng ít phải đoán. -->
- Câu hỏi nghiên cứu chính: <...>
- Dữ liệu: <nguồn, kích thước, giai đoạn, đơn vị, các cột quan trọng>
- Đặc điểm dữ liệu cần lưu ý: <ví dụ: có ngày nghỉ lễ, có giá trị thiếu ở cột X>
- Người đọc báo cáo: <bản thân / đồng nghiệp / hội đồng>

# Cấu trúc thư mục

- `data/raw/` — dữ liệu gốc. CHỈ ĐỌC, không bao giờ sửa, ghi đè hay xóa.
- `data/processed/` — dữ liệu đã làm sạch, luôn sinh ra từ một script trong `analysis/`.
- `analysis/` — mọi code phân tích. Đặt tên có số thứ tự: `01_lam_sach.py`, `02_thong_ke_mo_ta.py`...
- `figures/` — hình. Tên hình bắt đầu bằng tên script tạo ra nó: `02_thong_ke_mo_ta__phan_phoi.png`.
- `reports/` — báo cáo dạng Markdown.
- `NOTES.md` — nhật ký các phiên: đã làm gì, quyết định gì, bước tiếp theo.

# Quy trình lập luận khoa học (bắt buộc)

## Trước khi phân tích
1. Nêu lại câu hỏi bằng lời của bạn và xác nhận với người dùng nếu có chỗ mơ hồ.
2. Nêu giả thuyết, phương pháp kiểm định, và **kết quả nào sẽ bác bỏ giả thuyết**.
3. Với phân tích nhiều bước: trình bày kế hoạch và chờ người dùng duyệt trước khi chạy.

## Trong khi phân tích
4. Kiểm tra dữ liệu trước khi mô hình hóa: kích thước, kiểu dữ liệu, giá trị thiếu,
   trùng lặp, outlier, phân phối. Báo những gì bất thường.
5. Ghi rõ mọi giả định của phương pháp và kiểm tra chúng khi có thể
   (ví dụ: tính dừng, phân phối phần dư, độc lập). Giả định không kiểm tra được thì nói rõ.
6. Chạy code qua file script trong `analysis/`, không chạy code rời rạc cho kết quả
   sẽ được báo cáo. Ai cũng phải chạy lại được từ đầu và ra cùng kết quả.
7. Cố định random seed khi có yếu tố ngẫu nhiên.
8. Tránh "câu cá" kết quả: nếu thử nhiều cấu hình, báo cáo tất cả đã thử,
   không chỉ cấu hình đẹp nhất.

## Khi kết luận
9. Mỗi con số đưa ra phải truy được về một script và output cụ thể.
10. Luôn xét ít nhất một cách giải thích khác cho kết quả và nói vì sao loại hoặc giữ nó.
11. Báo cỡ hiệu ứng và khoảng tin cậy, không chỉ p-value. Ý nghĩa thống kê
    khác ý nghĩa thực tế.
12. Phân biệt rõ ba mức:
    - **Đã kiểm chứng**: dữ liệu trong project cho thấy trực tiếp.
    - **Có bằng chứng ủng hộ**: nhất quán với dữ liệu nhưng chưa loại trừ được giải thích khác.
    - **Suy đoán**: giả thuyết cần kiểm tra thêm.
13. Nêu hạn chế: cỡ mẫu, giai đoạn dữ liệu, sai lệch chọn mẫu, khả năng tổng quát hóa.
14. Không trích dẫn tài liệu theo trí nhớ. Chỉ dẫn nguồn đã tra được qua công cụ;
    nếu không tra được thì nói rõ là chưa kiểm chứng nguồn.

# Phản biện trước khi báo cáo

Trước khi đưa kết luận hoặc viết báo cáo, gọi subagent `reviewer` để kiểm tra.
Xử lý mọi vấn đề mức "Nghiêm trọng" trước khi báo cáo. Với các vấn đề còn lại,
sửa hoặc ghi rõ trong phần Hạn chế. Cho người dùng biết reviewer đã nêu những gì.

# Báo cáo

Báo cáo trong `reports/` theo cấu trúc: Tóm tắt, Dữ liệu, Phương pháp, Kết quả,
Thảo luận, Hạn chế, Kết luận, Tái lập (danh sách script theo thứ tự chạy).
Nhúng hình từ `figures/`. Không dán code vào báo cáo.

# Git

- Commit sau mỗi kết quả quan trọng, message ghi rõ kết quả gì, từ script nào.
- Không commit dữ liệu lớn hoặc dữ liệu nhạy cảm; hỏi người dùng nếu không chắc.
