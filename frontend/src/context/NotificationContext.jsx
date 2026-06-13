import React, {
  createContext, useContext, useEffect, useRef, useState, useCallback,
} from "react";
import { io } from "socket.io-client";
import { useAuth } from "./AuthContext";
import notificationService from "../services/notificationService";
import { API_ORIGIN } from "../services/env";

const NotificationContext = createContext(null);

const SOCKET_URL = API_ORIGIN;

export function NotificationProvider({ children }) {
  const { user, isAuthenticated } = useAuth();

  const [notifications, setNotifications]   = useState([]);
  const [unreadCount,   setUnreadCount]     = useState(0);
  const [loading,       setLoading]         = useState(false);
  const [page,          setPage]            = useState(1);
  const [hasMore,       setHasMore]         = useState(true);
  const socketRef = useRef(null);

  // ── Load initial notifications ──────────────────────────────────────────────
  const fetchNotifications = useCallback(async (reset = false) => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const p = reset ? 1 : page;
      const data = await notificationService.getAll(p, 20);
      setNotifications((prev) => reset ? data.items : [...prev, ...data.items]);
      setHasMore(data.items.length === 20 && data.total > p * 20);
      if (!reset) setPage((v) => v + 1);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [isAuthenticated, page]);

  const refreshCount = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const count = await notificationService.getUnreadCount();
      setUnreadCount(count);
    } catch { /* silent */ }
  }, [isAuthenticated]);

  // ── On auth change: reset + reload ─────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated) {
      setNotifications([]);
      setUnreadCount(0);
      setPage(1);
      setHasMore(true);
      return;
    }
    setPage(1);
    fetchNotifications(true);
    refreshCount();
  }, [isAuthenticated]); // eslint-disable-line

  // ── Socket.IO real-time ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user?._id) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      return;
    }

    const socket = io(`${SOCKET_URL}/realtime`, {
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnection: true,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-user", { userId: user._id });
    });

    socket.on("notification:new", (notif) => {
      setNotifications((prev) => [notif, ...prev]);
      setUnreadCount((c) => c + 1);
    });

    return () => {
      socket.emit("leave-user", { userId: user._id });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated, user?._id]); // eslint-disable-line

  // ── Actions ─────────────────────────────────────────────────────────────────
  const markRead = useCallback(async (id) => {
    try {
      await notificationService.markRead(id);
      setNotifications((prev) =>
        prev.map((n) => n._id === id ? { ...n, isRead: true } : n)
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch { /* silent */ }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await notificationService.markAllRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch { /* silent */ }
  }, []);

  const deleteNotif = useCallback(async (id) => {
    const target = notifications.find((n) => n._id === id);
    try {
      await notificationService.deleteOne(id);
      setNotifications((prev) => prev.filter((n) => n._id !== id));
      if (target && !target.isRead) setUnreadCount((c) => Math.max(0, c - 1));
    } catch { /* silent */ }
  }, [notifications]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) fetchNotifications(false);
  }, [loading, hasMore, fetchNotifications]);

  return (
    <NotificationContext.Provider value={{
      notifications, unreadCount, loading, hasMore,
      markRead, markAllRead, deleteNotif, loadMore,
      refresh: () => { setPage(1); fetchNotifications(true); refreshCount(); },
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used inside NotificationProvider");
  return ctx;
}
