import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { useAuth } from "../../context/AuthContext";
import chatService from "../../services/chatService";
import { uploadApi } from "../../services/uploadService";
import { Avatar, Button, Skeleton } from "@heroui/react";
import {
  MessageCircle, Send, Loader2, Users,
  Package, ShoppingBag, ExternalLink, ImagePlus, X,
} from "lucide-react";
import { formatCurrency } from "../../utils/formatCurrency";
import { API_ORIGIN } from "../../services/env";

const SOCKET_URL = API_ORIGIN;

function timeAgo(date) {
  if (!date) return "";
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60000)    return "Vừa xong";
  if (diff < 3600000)  return `${Math.floor(diff / 60000)} phút`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ`;
  return new Date(date).toLocaleDateString("vi-VN");
}

/* ── Context card shown in message thread ── */
function ContextCard({ ctx }) {
  if (!ctx?.type || !ctx?.data) return null;

  if (ctx.type === "product") {
    const { name, image, price, slug } = ctx.data;
    return (
      <div
        className="rounded-xl border border-default-200 dark:border-zinc-600 bg-white dark:bg-[#1a1e2e] overflow-hidden cursor-pointer hover:border-primary transition-colors"
        onClick={() => slug && window.open(`/products/${slug}`, "_blank")}
      >
        <div className="flex items-center gap-2.5 p-2.5">
          {image
            ? <img src={image} alt={name} className="w-12 h-12 object-cover rounded-lg flex-shrink-0" />
            : <div className="w-12 h-12 rounded-lg bg-default-100 flex items-center justify-center flex-shrink-0"><Package size={20} className="text-default-300" /></div>
          }
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-primary font-semibold mb-0.5">Sản phẩm được hỏi</p>
            <p className="text-sm text-default-800 dark:text-[#e8eaed] line-clamp-2 font-medium leading-tight">{name}</p>
            {price > 0 && <p className="text-xs text-danger font-semibold mt-0.5">{formatCurrency(price)}</p>}
          </div>
          <ExternalLink size={14} className="text-default-300 flex-shrink-0" />
        </div>
      </div>
    );
  }

  if (ctx.type === "order") {
    const { order_code, total_price, status, items = [] } = ctx.data;
    const STATUS_VI = {
      order_created: "Đặt hàng", confirmed: "Đã xác nhận", processing: "Đang xử lý",
      in_transit: "Đang giao", delivered: "Đã giao", cancelled_by_customer: "Đã hủy",
    };
    return (
      <div className="rounded-xl border border-default-200 dark:border-zinc-600 bg-white dark:bg-[#1a1e2e] p-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <ShoppingBag size={14} className="text-primary flex-shrink-0" />
          <p className="text-[10px] text-primary font-semibold">Đơn hàng được hỏi</p>
        </div>
        <p className="text-sm font-bold text-default-800 dark:text-[#e8eaed]">#{order_code}</p>
        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
          {total_price > 0 && <span className="text-sm text-danger font-semibold">{formatCurrency(total_price)}</span>}
          {status && <span className="text-xs text-default-400">{STATUS_VI[status] || status}</span>}
        </div>
        {items.length > 0 && (
          <div className="flex gap-2 mt-2">
            {items.slice(0, 3).map((it, i) => (
              <div key={i} className="flex items-center gap-1.5 flex-1 min-w-0">
                {it.image_url
                  ? <img src={it.image_url} alt={it.name} className="w-8 h-8 object-cover rounded-md flex-shrink-0" />
                  : <div className="w-8 h-8 rounded-md bg-default-100 flex-shrink-0" />
                }
                <p className="text-xs text-default-500 truncate">{it.name}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}

export default function ShopInbox() {
  const { user } = useAuth();

  const [conversations, setConvs]     = useState([]);
  const [activeConv, setActiveConv]   = useState(null);
  const [messages, setMessages]       = useState([]);
  const [input, setInput]             = useState("");
  const [sending, setSending]         = useState(false);
  const [loading, setLoading]         = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  // {id, objectUrl, url, uploading}
  const [pendingImages, setPendingImages] = useState([]);

  const socketRef        = useRef(null);
  const msgContainerRef  = useRef(null); // scroll container
  const imageInputRef    = useRef(null);
  // Guards against concurrent sends (rapid Enter presses)
  const sendingRef     = useRef(false);
  // Ref copy of activeConv — avoids stale closure in socket handlers
  const activeConvRef  = useRef(null);

  useEffect(() => { activeConvRef.current = activeConv; }, [activeConv]);

  // ── Socket connection ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!user?._id) return;

    const s = io(`${SOCKET_URL}/realtime`, {
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnection: true,
    });

    s.on("connect", () => s.emit("join-user", { userId: user._id }));

    // message:new — fired to the conversation room (received by both parties)
    s.on("message:new", ({ conversation_id, message }) => {
      const isActive = activeConvRef.current?._id === conversation_id;
      if (isActive) {
        setMessages(msgs => {
          if (msgs.find(m => m._id === message._id)) return msgs; // already present
          // Replace optimistic temp message if this is our own message echoed back
          const tempIdx = msgs.findIndex(
            m => m._id.startsWith("tmp-") && message.sender_type === "shop"
          );
          if (tempIdx !== -1) {
            const updated = [...msgs];
            updated[tempIdx] = message;
            return updated;
          }
          return [...msgs, message];
        });
      }
      // Update conversation list preview
      setConvs(prev => prev.map(c =>
        c._id === conversation_id
          ? {
              ...c,
              last_message: message.content || (message.images?.length ? "[Hình ảnh]" : c.last_message),
              last_message_at: message.createdAt,
              unread_shop: isActive
                ? c.unread_shop
                : message.sender_type === "customer"
                  ? (c.unread_shop || 0) + 1
                  : c.unread_shop,
            }
          : c
      ));
    });

    // chat:new_message — fired to user room for conversations NOT currently in view
    // (e.g., customer messages a different conversation while shop is in another)
    s.on("chat:new_message", ({ conversation_id, message }) => {
      const isActive = activeConvRef.current?._id === conversation_id;
      if (isActive) return; // already handled by message:new above

      setConvs(prev => prev.map(c =>
        c._id === conversation_id
          ? {
              ...c,
              last_message: message.content || (message.images?.length ? "[Hình ảnh]" : c.last_message),
              last_message_at: message.createdAt,
              unread_shop: message.sender_type === "customer"
                ? (c.unread_shop || 0) + 1
                : c.unread_shop,
            }
          : c
      ));
    });

    socketRef.current = s;

    return () => {
      s.emit("leave-user", { userId: user._id });
      s.close();
      socketRef.current = null;
    };
  }, [user?._id]); // eslint-disable-line

  // ── Join / leave conversation room ────────────────────────────────────────
  useEffect(() => {
    if (!activeConv || !socketRef.current) return;
    socketRef.current.emit("join-conversation", { conversationId: activeConv._id });
    return () => {
      socketRef.current?.emit("leave-conversation", { conversationId: activeConv._id });
    };
  }, [activeConv?._id]); // eslint-disable-line

  // ── Load conversations on mount ───────────────────────────────────────────
  useEffect(() => {
    chatService.shopListConversations()
      .then(data => setConvs(data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // ── Open a conversation and load its messages ─────────────────────────────
  const openConversation = useCallback(async (conv) => {
    setActiveConv(conv);
    setPendingImages([]);
    setLoadingMsgs(true);
    try {
      const data = await chatService.shopGetMessages(conv._id);
      setMessages(data.messages || []);
      setConvs(prev => prev.map(c =>
        c._id === conv._id ? { ...c, unread_shop: 0 } : c
      ));
    } catch { /* silent */ }
    finally { setLoadingMsgs(false); }
  }, []);

  // ── Auto-scroll (scroll the container, not the page) ─────────────────────
  useEffect(() => {
    const el = msgContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ── Image upload ──────────────────────────────────────────────────────────
  const handleImageSelect = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    e.target.value = "";
    const token = localStorage.getItem("access_token");

    const newImgs = files.map(f => ({
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      objectUrl: URL.createObjectURL(f),
      url: null,
      uploading: true,
    }));
    setPendingImages(prev => [...prev, ...newImgs]);

    await Promise.all(files.map(async (file, i) => {
      try {
        const res = await uploadApi.uploadSingle(file, "dfs/chat", token);
        setPendingImages(prev =>
          prev.map(p => p.id === newImgs[i].id ? { ...p, url: res.url, uploading: false } : p)
        );
      } catch {
        setPendingImages(prev => prev.filter(p => p.id !== newImgs[i].id));
      }
    }));
  };

  // ── Send message ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text      = input.trim();
    const imageUrls = pendingImages.filter(p => p.url && !p.uploading).map(p => p.url);

    if ((!text && !imageUrls.length) || !activeConv) return;
    if (sendingRef.current) return; // prevent double-send from rapid Enter presses

    sendingRef.current = true;
    const tempId = `tmp-${Date.now()}`;
    setInput("");
    setPendingImages([]);
    setSending(true);

    const temp = {
      _id: tempId,
      sender_id: user._id,
      sender_type: "shop",
      content: text,
      images: imageUrls,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, temp]);

    try {
      const msg = await chatService.shopSendMessage(activeConv._id, text, imageUrls);
      // Replace temp only if socket hasn't already done so via message:new
      setMessages(prev => {
        if (prev.find(m => m._id === tempId)) return prev.map(m => m._id === tempId ? msg : m);
        if (prev.find(m => m._id === msg._id)) return prev; // socket already replaced
        return [...prev.filter(m => m._id !== tempId), msg];
      });
    } catch {
      setMessages(prev => prev.filter(m => m._id !== tempId));
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [input, pendingImages, activeConv, user?._id]); // eslint-disable-line

  const totalUnread   = conversations.reduce((s, c) => s + (c.unread_shop || 0), 0);
  const hasUploading  = pendingImages.some(p => p.uploading);
  const canSend       = (input.trim() || pendingImages.some(p => p.url)) && !hasUploading;

  return (
    <div className="h-[calc(100vh-120px)] flex rounded-2xl overflow-hidden border border-default-100 dark:border-[#2e3347] bg-white dark:bg-[#131620] shadow-sm">

      {/* ── Conversation list ───────────────────────────────────────────── */}
      <div className="w-72 flex-shrink-0 border-r border-default-100 dark:border-[#2e3347] flex flex-col">
        <div className="px-4 py-4 border-b border-default-100 dark:border-[#2e3347] bg-gradient-to-r from-primary/5 to-violet-500/5 dark:from-primary/10 dark:to-violet-500/10">
          <h2 className="font-bold text-default-900 dark:text-[#e8eaed] flex items-center gap-2">
            <MessageCircle size={18} className="text-primary" />
            Tin nhắn
            {totalUnread > 0 && (
              <span className="ml-auto bg-danger text-white text-xs font-bold rounded-full px-2 py-0.5">
                {totalUnread}
              </span>
            )}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-default-400 p-6">
              <Users size={32} className="text-default-200" />
              <p className="text-sm text-center">Chưa có tin nhắn nào từ khách hàng</p>
            </div>
          ) : (
            conversations.map(conv => (
              <button
                key={conv._id}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-default-50 dark:border-[#222738] ${
                  activeConv?._id === conv._id
                    ? "bg-primary-50 dark:bg-primary-900/20 border-l-2 border-l-primary"
                    : "hover:bg-default-50 dark:hover:bg-zinc-800"
                }`}
                onClick={() => openConversation(conv)}
              >
                <Avatar
                  src={conv.customer?.avatar}
                  name={conv.customer?.name?.charAt(0) || "K"}
                  size="sm"
                  className="w-10 h-10 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className={`text-sm truncate ${conv.unread_shop > 0 ? "font-bold text-default-900 dark:text-[#e8eaed]" : "font-semibold text-default-800 dark:text-[#d1d5db]"}`}>
                      {conv.customer?.name || "Khách hàng"}
                    </p>
                    <span className="text-[10px] text-default-400 ml-2 flex-shrink-0">
                      {timeAgo(conv.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className={`text-xs truncate flex-1 ${conv.unread_shop > 0 ? "text-default-700 dark:text-[#c8cbd4] font-medium" : "text-default-400"}`}>
                      {conv.last_message || "Bắt đầu cuộc trò chuyện"}
                    </p>
                    {conv.unread_shop > 0 && (
                      <span className="ml-2 flex-shrink-0 bg-danger text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                        {conv.unread_shop > 9 ? "9+" : conv.unread_shop}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Message area ───────────────────────────────────────────────── */}
      {!activeConv ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-default-400 bg-gradient-to-br from-slate-50 to-indigo-50/30 dark:from-zinc-900 dark:to-zinc-800">
          <div className="p-5 rounded-full bg-white dark:bg-[#1a1e2e] shadow-md">
            <MessageCircle size={40} className="text-primary/40" />
          </div>
          <p className="text-sm text-default-400">Chọn cuộc trò chuyện để bắt đầu</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-default-100 dark:border-[#2e3347] flex-shrink-0 bg-white dark:bg-[#131620]">
            <Avatar
              src={activeConv.customer?.avatar}
              name={activeConv.customer?.name?.charAt(0)}
              size="sm"
            />
            <div>
              <p className="font-semibold text-sm text-default-900 dark:text-[#e8eaed]">
                {activeConv.customer?.name || "Khách hàng"}
              </p>
              <p className="text-xs text-green-500 font-medium">● Đang hoạt động</p>
            </div>
          </div>

          {/* Messages — with chat background */}
          <div ref={msgContainerRef} className="flex-1 overflow-y-auto relative">
            {/* Dot pattern background (light mode) */}
            <div
              className="absolute inset-0 pointer-events-none dark:opacity-0"
              style={{
                backgroundColor: "#f0f4ff",
                backgroundImage: "radial-gradient(circle, rgba(99,102,241,0.1) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }}
            />
            {/* Dark mode background */}
            <div className="absolute inset-0 pointer-events-none opacity-0 dark:opacity-100 bg-zinc-800" />

            <div className="relative px-5 py-4 space-y-3 min-h-full flex flex-col justify-end">
              {loadingMsgs ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-default-300" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-default-400">Hãy gửi tin nhắn đầu tiên</p>
                </div>
              ) : (
                messages.map(msg => {
                  const isMe = msg.sender_type === "shop";

                  // Context card message
                  if (msg.context_type && msg.context_data) {
                    return (
                      <div key={msg._id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                        {!isMe && (
                          <Avatar
                            src={activeConv.customer?.avatar}
                            size="sm"
                            className="w-7 h-7 mr-2 mt-auto flex-shrink-0"
                          />
                        )}
                        <div className="max-w-[75%]">
                          <ContextCard ctx={{ type: msg.context_type, data: msg.context_data }} />
                          <p className={`text-[10px] text-default-400 mt-0.5 ${isMe ? "text-right" : "text-left"}`}>
                            {timeAgo(msg.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={msg._id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                      {!isMe && (
                        <Avatar
                          src={activeConv.customer?.avatar}
                          size="sm"
                          className="w-7 h-7 mr-2 mt-auto flex-shrink-0"
                        />
                      )}
                      <div className="max-w-[65%]">
                        {msg.content && (
                          <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                            isMe
                              ? "bg-primary text-white rounded-br-sm"
                              : "bg-white dark:bg-zinc-700 text-default-900 dark:text-[#e8eaed] rounded-bl-sm"
                          }`}>
                            {msg.content}
                          </div>
                        )}
                        {msg.images?.length > 0 && (
                          <div className={`mt-1 grid ${msg.images.length > 1 ? "grid-cols-2" : "grid-cols-1"} gap-1`}>
                            {msg.images.map((img, i) => (
                              <img
                                key={i}
                                src={img}
                                alt=""
                                className="rounded-xl max-w-full cursor-pointer shadow-sm hover:opacity-90 transition-opacity"
                                onClick={() => window.open(img, "_blank")}
                              />
                            ))}
                          </div>
                        )}
                        <p className={`text-[10px] text-default-400 mt-0.5 ${isMe ? "text-right" : "text-left"}`}>
                          {timeAgo(msg.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              <div />
            </div>
          </div>

          {/* Pending image previews */}
          {pendingImages.length > 0 && (
            <div className="flex gap-2 px-5 py-2 border-t border-default-100 dark:border-[#2e3347] overflow-x-auto flex-shrink-0 bg-white dark:bg-[#131620]">
              {pendingImages.map(img => (
                <div key={img.id} className="relative flex-shrink-0">
                  <img
                    src={img.objectUrl}
                    alt=""
                    className={`w-16 h-16 object-cover rounded-xl border border-default-200 dark:border-zinc-600 ${img.uploading ? "opacity-50" : ""}`}
                  />
                  {img.uploading && (
                    <Loader2 size={18} className="absolute inset-0 m-auto animate-spin text-primary" />
                  )}
                  {!img.uploading && (
                    <button
                      onClick={() => setPendingImages(prev => prev.filter(p => p.id !== img.id))}
                      className="absolute -top-1.5 -right-1.5 bg-danger text-white rounded-full w-5 h-5 flex items-center justify-center shadow"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="px-5 py-3 border-t border-default-100 dark:border-[#2e3347] flex items-center gap-3 flex-shrink-0 bg-white dark:bg-[#131620]">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={handleImageSelect}
            />
            <button
              onClick={() => imageInputRef.current?.click()}
              className="text-default-400 hover:text-primary transition-colors flex-shrink-0 p-1"
              title="Gửi ảnh"
            >
              <ImagePlus size={20} />
            </button>
            <input
              className="flex-1 text-sm bg-default-50 dark:bg-[#1a1e2e] border border-default-200 dark:border-zinc-600 rounded-xl px-4 py-2.5 outline-none focus:border-primary transition-colors"
              placeholder="Nhập tin nhắn..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <Button
              isIconOnly
              color="primary"
              radius="full"
              isLoading={sending}
              isDisabled={!canSend}
              onPress={handleSend}
            >
              <Send size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
