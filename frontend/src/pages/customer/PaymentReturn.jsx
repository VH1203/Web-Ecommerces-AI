import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, Link as RouterLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Chip, Divider, Spinner } from "@heroui/react";
import {
  CheckCircle2,
  XCircle,
  Home,
  Receipt,
  CreditCard,
  Hash,
  Calendar,
  Banknote,
  AlertCircle,
  Wallet,
} from "lucide-react";
import { API_URL } from "../../services/apiClient";

function parseVNDate(s) {
  if (!s || s.length < 14) return "";
  try {
    const year   = s.slice(0, 4);
    const month  = s.slice(4, 6);
    const day    = s.slice(6, 8);
    const hour   = s.slice(8, 10);
    const minute = s.slice(10, 12);
    const second = s.slice(12, 14);
    const d = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+07:00`);
    return d.toLocaleString("vi-VN", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function formatVND(amount) {
  if (!amount) return "";
  return Number(amount).toLocaleString("vi-VN") + " ₫";
}

function DetailRow({ icon: Icon, label, value, highlight }) {
  if (!value) return null;
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center justify-between py-2.5"
    >
      <span className="flex items-center gap-2 text-sm text-default-500">
        <Icon size={14} className="flex-shrink-0" />
        {label}
      </span>
      <span
        className={`text-sm font-semibold ${highlight ? "text-primary-600 text-base" : "text-default-800"}`}
      >
        {value}
      </span>
    </motion.div>
  );
}

export default function PaymentReturn() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const VNPAY_RESPONSE_CODES = {
    "00": t("payment.vnpay_00"),
    "07": t("payment.vnpay_07"),
    "09": t("payment.vnpay_09"),
    "10": t("payment.vnpay_10"),
    "11": t("payment.vnpay_11"),
    "12": t("payment.vnpay_12"),
    "13": t("payment.vnpay_13"),
    "24": t("payment.vnpay_24"),
    "51": t("payment.vnpay_51"),
    "65": t("payment.vnpay_65"),
    "75": t("payment.vnpay_75"),
    "79": t("payment.vnpay_79"),
    "99": t("payment.vnpay_99"),
  };

  const rawStatus = params.get("status")     || "";
  const orderCode = params.get("order_code") || params.get("orderId") || "";
  const txnNo     = params.get("txn_no")     || "";
  const bank      = params.get("bank")       || "";
  const amount    = params.get("amount")     || "";
  const payDate   = params.get("pay_date")   || "";
  const code      = params.get("code")       || "";
  const reason    = params.get("reason")     || "";
  const isDeposit = params.get("deposit")    === "1";

  // polling state — used when VNPay didn't pass status params (sandbox restriction)
  const [polledStatus, setPolledStatus] = useState(null); // "success" | "fail" | null
  const [polling, setPolling]           = useState(!rawStatus && !!orderCode);
  const pollRef = useRef(null);

  useEffect(() => {
    if (!orderCode || rawStatus) return; // no need to poll if we already have a status
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const res  = await fetch(`${API_URL}/payment/vnpay/check?order_code=${encodeURIComponent(orderCode)}`);
        const json = await res.json();
        const ps   = json?.data?.payment_status;
        if (ps === "paid") {
          clearInterval(pollRef.current);
          setPolledStatus("success");
          setPolling(false);
        } else if (ps === "failed" || attempts >= 12) {
          clearInterval(pollRef.current);
          setPolledStatus(ps === "failed" ? "fail" : "fail");
          setPolling(false);
        }
      } catch { /* ignore network errors during poll */ }
    }, 5000); // poll every 5s, max 12 times (1 min)
    return () => clearInterval(pollRef.current);
  }, [orderCode, rawStatus]);

  const status     = polledStatus || rawStatus || "fail";
  const isSuccess  = status === "success";
  const payDateStr = parseVNDate(payDate);
  const errorMsg   = code ? (VNPAY_RESPONSE_CODES[code] || `${t("common.error")}: ${code}`) : "";

  const successDest = isDeposit ? "/wallet" : "/orders";

  const [count, setCount] = useState(isSuccess ? 8 : 15);
  useEffect(() => {
    if (polling) return; // don't countdown while polling
    const timer = setInterval(() => setCount((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [polling]);
  useEffect(() => {
    if (count === 0) nav(isSuccess ? successDest : "/");
  }, [count, nav, isSuccess, successDest]);

  const hasDetails = !!(orderCode || txnNo || amount || bank || payDateStr);

  if (polling) {
    return (
      <div className="min-h-dvh grid place-items-center p-4 bg-gradient-to-br from-blue-50 to-white">
        <div className="flex flex-col items-center gap-4 text-center">
          <Spinner size="lg" color="primary" />
          <p className="text-default-600 font-medium">Đang kiểm tra kết quả thanh toán VNPay…</p>
          {orderCode && <p className="text-xs text-default-400">Mã đơn: {orderCode}</p>}
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-dvh grid place-items-center p-4"
      style={{
        background: isSuccess
          ? "linear-gradient(160deg, #f0fff4 0%, #ecfdf5 40%, #f0f9ff 100%)"
          : "linear-gradient(160deg, #fff1f2 0%, #fef2f2 40%, #fff 100%)",
      }}
    >
      <div
        className="fixed inset-0 pointer-events-none overflow-hidden"
        style={{ zIndex: 0 }}
      >
        <div
          style={{
            position: "absolute",
            width: 500, height: 500,
            top: -100, right: -100,
            borderRadius: "50%",
            background: isSuccess
              ? "radial-gradient(circle, rgba(34,197,94,0.07) 0%, transparent 70%)"
              : "radial-gradient(circle, rgba(239,68,68,0.07) 0%, transparent 70%)",
          }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.88, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 280, damping: 22 }}
        className="relative z-10 max-w-md w-full"
      >
        <div
          className="rounded-3xl overflow-hidden"
          style={{
            background: "#fff",
            boxShadow: isSuccess
              ? "0 8px 40px rgba(34,197,94,0.14), 0 2px 12px rgba(0,0,0,0.06)"
              : "0 8px 40px rgba(239,68,68,0.12), 0 2px 12px rgba(0,0,0,0.06)",
            border: `1.5px solid ${isSuccess ? "#bbf7d0" : "#fecaca"}`,
          }}
        >
          <div
            style={{
              height: 5,
              background: isSuccess
                ? "linear-gradient(90deg, #22c55e, #4ade80)"
                : "linear-gradient(90deg, #ef4444, #f87171)",
            }}
          />

          <div className="p-8 flex flex-col items-center gap-5 text-center">

            {/* Animated icon */}
            <motion.div
              initial={{ scale: 0, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 18, delay: 0.12 }}
            >
              {isSuccess ? (
                <div
                  className="w-24 h-24 rounded-full flex items-center justify-center"
                  style={{ background: "linear-gradient(135deg, #dcfce7, #bbf7d0)" }}
                >
                  <CheckCircle2 size={54} style={{ color: "#16a34a" }} />
                </div>
              ) : (
                <div
                  className="w-24 h-24 rounded-full flex items-center justify-center"
                  style={{ background: "linear-gradient(135deg, #fee2e2, #fecaca)" }}
                >
                  <XCircle size={54} style={{ color: "#dc2626" }} />
                </div>
              )}
            </motion.div>

            {/* Title & order chip */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.22 }}
              className="space-y-2"
            >
              <h2
                className="text-2xl font-black"
                style={{ color: isSuccess ? "#15803d" : "#b91c1c" }}
              >
                {isSuccess
                  ? (isDeposit ? "Nạp tiền thành công!" : t("payment.success_title"))
                  : (isDeposit ? "Nạp tiền thất bại"    : t("payment.failed_title"))}
              </h2>

              {!!orderCode && !isDeposit && (
                <Chip
                  color={isSuccess ? "success" : "danger"}
                  variant="flat"
                  size="sm"
                  startContent={<Hash size={11} />}
                >
                  {t("payment.order_label")} {orderCode}
                </Chip>
              )}

              {!isSuccess && errorMsg && (
                <div
                  className="flex items-center gap-1.5 justify-center text-xs mt-1"
                  style={{ color: "#b91c1c" }}
                >
                  <AlertCircle size={12} />
                  {errorMsg}
                </div>
              )}

              {!isSuccess && reason === "invalid_signature" && (
                <p className="text-xs text-danger-500">{t("payment.invalid_signature")}</p>
              )}
              {!isSuccess && reason === "server_error" && (
                <p className="text-xs text-danger-500">{t("payment.server_error")}</p>
              )}
            </motion.div>

            {/* Message */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.32 }}
              className="text-sm leading-relaxed"
              style={{ color: "#6b7280" }}
            >
              {isSuccess ? t("payment.success_msg") : t("payment.failed_msg")}
            </motion.p>

            {/* Detail table */}
            <AnimatePresence>
              {hasDetails && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ delay: 0.38, duration: 0.32 }}
                  className="w-full rounded-2xl px-4 py-1"
                  style={{
                    background: isSuccess ? "#f0fdf4" : "#fff1f2",
                    border: `1px solid ${isSuccess ? "#bbf7d0" : "#fecaca"}`,
                  }}
                >
                  {amount && (
                    <DetailRow icon={Banknote} label={t("payment.amount_label")} value={formatVND(amount)} highlight />
                  )}
                  {amount && (orderCode || txnNo || bank || payDateStr) && (
                    <Divider className="my-0.5" />
                  )}
                  <DetailRow icon={Hash}       label={t("payment.order_code_label")} value={orderCode} />
                  <DetailRow icon={CreditCard} label={t("payment.txn_label")}        value={txnNo} />
                  <DetailRow icon={Banknote}   label={t("payment.bank_label")}       value={bank} />
                  <DetailRow icon={Calendar}   label={t("payment.time_label")}       value={payDateStr} />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Countdown */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="text-xs"
              style={{ color: "#9ca3af" }}
            >
              {t("payment.redirect_to")}{" "}
              <span className="font-semibold" style={{ color: isSuccess ? "#16a34a" : "#6b7280" }}>
                {isSuccess
                  ? (isDeposit ? "Ví của tôi" : t("payment.my_orders"))
                  : t("payment.home")}
              </span>{" "}
              {t("payment.redirect_after")} <span className="font-bold">{count}s</span>
            </motion.p>

            {/* Action buttons */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45 }}
              className="flex gap-3 mt-1 w-full"
            >
              <Button
                as={RouterLink}
                to="/"
                variant="bordered"
                radius="xl"
                startContent={<Home size={15} />}
                className="font-semibold flex-1"
              >
                {t("payment.go_home")}
              </Button>
              {isDeposit ? (
                <Button
                  as={RouterLink}
                  to="/wallet"
                  color={isSuccess ? "success" : "primary"}
                  radius="xl"
                  startContent={<Wallet size={15} />}
                  className="font-bold flex-1 shadow-md text-white"
                >
                  Về ví
                </Button>
              ) : (
                <Button
                  as={RouterLink}
                  to="/orders"
                  color={isSuccess ? "success" : "primary"}
                  radius="xl"
                  startContent={<Receipt size={15} />}
                  className="font-bold flex-1 shadow-md text-white"
                >
                  {t("payment.view_orders")}
                </Button>
              )}
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
