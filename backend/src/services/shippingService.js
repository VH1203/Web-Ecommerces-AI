const Address = require("../models/Address");
const ghn = require("./ghnService");

function fallbackFee(provider, items) {
  const base = provider === "GHTK" ? 18000 : 15000;
  const step = Math.max(0, (items?.length || 0) - 1) * 2000;
  return base + step;
}

exports.calculate = async (provider = "GHN", address_id, address, items) => {
  if (!items?.length) return 0;
  if (provider !== "GHN") return fallbackFee(provider, items);

  const addr = address || (address_id ? await Address.findById(address_id).lean() : null);
  const toDistrictId = addr?.district_code || addr?.district_id;
  const toWardCode = addr?.ward_code;

  if (!toDistrictId || !toWardCode || process.env.GHN_DEV_MODE === "true") {
    return fallbackFee(provider, items);
  }

  const weight = Math.max(
    500,
    items.reduce((sum, item) => sum + (Number(item.weight) || 500) * (Number(item.qty) || 1), 0)
  );
  const data = await ghn.calculateFee({ toDistrictId, toWardCode, weight });
  return Number(data?.total || data?.service_fee || data?.main_service || 0) || fallbackFee(provider, items);
};

exports.getTracking = async (provider = "GHN", orderCode) => {
  if (provider === "GHN" && orderCode && process.env.GHN_DEV_MODE !== "true") {
    const detail = await ghn.getOrderDetail(orderCode);
    const logs = Array.isArray(detail?.log) ? detail.log : [];
    return {
      provider,
      order_code: orderCode,
      steps: logs.map((l) => ({
        code: l.status,
        text: l.status || "GHN update",
        at: l.updated_date || l.action_at || l.created_at || new Date(),
      })),
      current: detail?.status || logs[0]?.status || "unknown",
    };
  }

  return {
    provider,
    order_code: orderCode,
    steps: [
      { code: "confirmed", text: "Shop đã xác nhận", at: new Date(Date.now() - 1000 * 60 * 60 * 24) },
      { code: "processing", text: "Đang đóng gói", at: new Date(Date.now() - 1000 * 60 * 60 * 20) },
      { code: "shipping", text: "Đang giao", at: new Date(Date.now() - 1000 * 60 * 60 * 5) },
    ],
    current: "shipping",
  };
};
