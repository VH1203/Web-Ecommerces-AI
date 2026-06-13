import { API_URL } from "./apiClient";

export const API_ORIGIN = (import.meta.env.VITE_SOCKET_URL || API_URL.replace(/\/api\/?$/, "")).replace(/\/+$/, "");
