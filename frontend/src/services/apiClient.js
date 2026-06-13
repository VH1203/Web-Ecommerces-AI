// src/services/apiClient.js
import axios from "axios";

export const TOKEN_KEY = "DFS_TOKEN"; // 🔒 chỉ dùng 1 key duy nhất
export const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:5000/api").replace(/\/+$/, "");

const apiClient = axios.create({
  baseURL: API_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 20000,
});

// ===== Helpers để dùng ở chỗ login/logout =====
export const setToken = (token) => {
  try {
    // dọn key cũ phòng sót
    localStorage.removeItem("dfs_token");
    localStorage.removeItem("access_token");
    localStorage.removeItem("accessToken");
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
};

export const clearAuthStorage = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("dfs_user");
    localStorage.removeItem("dfs_token");
    localStorage.removeItem("access_token");
    localStorage.removeItem("accessToken");
  } catch {}
};

// ===== Request interceptor =====
apiClient.interceptors.request.use((config) => {
  // Cho phép bỏ qua Authorization cho endpoint public
  if (config.skipAuth) return config;

  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ===== Response interceptor =====
apiClient.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status;
    const serverMsg =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      "Lỗi kết nối máy chủ.";

    if (status === 401) {
      clearAuthStorage();
      // Hard redirect để reset toàn bộ state
      window.location.replace("/login");
    }

    return Promise.reject(new Error(serverMsg));
  }
);

export default apiClient;
