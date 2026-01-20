# 🛍️ DFS - Smart Fashion E-Commerce Platform

[![Tech Stack](https://img.shields.io/badge/Stack-MERN-blue.svg)](https://mongodb.com)
[![AI Powered](https://img.shields.io/badge/AI-Size_Recommendation-green.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**DFS** là nền tảng thương mại điện tử chuyên biệt cho ngành thời trang, giải quyết bài toán lớn nhất của mua sắm online: **"Mua sai kích cỡ"**. Bằng việc tích hợp trí tuệ nhân tạo (AI), hệ thống giúp khách hàng tìm được sản phẩm vừa vặn nhất, đồng thời cung cấp giải pháp quản trị khép kín cho doanh nghiệp.

---

## 🌟 Tính Năng Cốt Lõi

### 🤖 AI & Cá Nhân Hóa (Điểm nhấn)
* **AI Size Recommendation:** Gợi ý size thông minh dựa trên chiều cao, cân nặng, số đo cơ thể và dữ liệu lịch sử.
* **Smart Filter:** Tìm kiếm sản phẩm theo xu hướng và sở thích người dùng.

### 💼 Quản Trị Hệ Thống (Multi-Role)
Hệ thống phân quyền sâu với 6 vai trò riêng biệt:
* **Customer:** Trải nghiệm mua sắm, theo dõi đơn hàng, nhận tư vấn AI.
* **Shop/Seller:** Quản lý kho hàng, thiết lập bảng size riêng cho sản phẩm.
* **Warehouse:** Kiểm soát nhập xuất kho, quản lý tồn kho thực tế.
* **Marketing:** Tạo chiến dịch khuyến mãi, mã giảm giá, tracking hiệu quả.
* **CS (Customer Service):** Chăm sóc khách hàng, xử lý khiếu nại/đổi trả.
* **Admin:** Quản trị toàn bộ dòng tiền, tài khoản và báo cáo hệ thống.

### 🚚 Vận Chuyển & Thanh Toán
* **Logistics:** Tích hợp trực tiếp API **GHN (Giao Hàng Nhanh)** và **GHTK (Giao Hàng Tiết Kiệm)**.
* **Payment:** Thanh toán linh hoạt qua **VNPay, MoMo** và **COD**.

---

## 💻 Tech Stack

| Thành phần | Công nghệ sử dụng |
| :--- | :--- |
| **Frontend** | ReactJS, Vite, TailwindCSS, Redux Toolkit |
| **Backend** | Node.js, Express Framework |
| **Database** | MongoDB (Dữ liệu chính), Redis (Caching & Queue) |
| **Security** | JWT (Access/Refresh Token), Bcrypt/Argon2 Salting |
| **Performance** | BullMQ (Xử lý tác vụ ngầm), Cloudflare CDN |
| **Testing/DevOps** | JMeter (Load test), Docker, Nginx, AWS |

---

## 🛠️ Hướng Dẫn Cài Đặt

### 1. Yêu cầu hệ thống
* Node.js (phiên bản 16.x trở lên)
* MongoDB & Redis đang chạy

### 2. Triển khai
```bash
# Clone dự án
git clone [https://github.com/VH1203/Web-Ecommerces-AI.git](https://github.com/VH1203/Web-Ecommerces-AI.git)

# Di chuyển vào thư mục dự án
cd Web-Ecommerces-AI

# Cài đặt thư viện
npm install

# Cấu hình môi trường
cp .env.example .env # Sau đó cập nhật các thông số Database, API Key

# Chạy dự án (Development)
npm start
