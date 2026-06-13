// services/ghnService.js
//
// GHN (Giao Hàng Nhanh) shipping API integration.
// Sandbox: https://dev-online-gateway.ghn.vn/shiip/public-api/v2/
//
// All calls are wrapped so failures never crash the calling flow.

const axios = require("axios");

const GHN_API_URL = process.env.GHN_API_URL || "https://dev-online-gateway.ghn.vn/shiip/public-api/v2";
const GHN_TOKEN = process.env.GHN_TOKEN;
const GHN_SHOP_ID = Number(process.env.GHN_SHOP_ID || 0);
const GHN_DEV_MODE = process.env.GHN_DEV_MODE === "true";

function ensureGhnConfig() {
  if ((!GHN_TOKEN || !GHN_SHOP_ID) && !GHN_DEV_MODE) {
    throw new Error("Missing GHN_TOKEN or GHN_SHOP_ID. Set GHN_DEV_MODE=true for local mock flows.");
  }
}
// Location endpoints live at /shiip/public-api (no /v2)
const GHN_DATA_URL = GHN_API_URL.replace(/\/v\d+$/, "");

// Axios instance for shipping order operations
const ghnClient = axios.create({
  baseURL: GHN_API_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
    "Token":        GHN_TOKEN || "",
    "ShopId":       String(GHN_SHOP_ID || ""),
  },
});

// Axios instance for master-data (province / district / ward) — no /v2
const ghnDataClient = axios.create({
  baseURL: GHN_DATA_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
    "Token":        GHN_TOKEN || "",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// GHN status → internal status mapping
// ─────────────────────────────────────────────────────────────────────────────
const GHN_STATUS_MAP = {
  ready_to_pick:               "processing",
  picking:                     "picking",
  picked:                      "picking",
  cancel:                      "cancelled_by_shop",
  storing:                     "packed",
  transporting:                "in_transit",
  sorting:                     "in_transit",
  delivering:                  "out_for_delivery",
  money_collect_delivering:    "out_for_delivery",
  delivered:                   "delivered",
  delivery_fail:               "delivery_failed",
  waiting_to_return:           "delivery_failed",
  return:                      "delivery_failed",
  returned:                    "delivery_failed",
  exception:                   "delivery_failed",
  lost:                        "delivery_failed",
};

/**
 * Map a GHN status string to our internal order status.
 * Returns null if the GHN status is unrecognised.
 */
function mapGhnStatus(ghnStatus) {
  return GHN_STATUS_MAP[(ghnStatus || "").toLowerCase()] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// createShippingOrder
// Creates a GHN shipping order for an existing platform order.
//
// @param {Object} order  — Mongoose Order document (with .shipping_address)
// @returns {Object}      — GHN response data (order_code, expected_delivery_time, …)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Fetch GHN province list (for shop pickup address setup).
 */
async function getProvinces() {
  ensureGhnConfig();
  const res = await ghnDataClient.get("/master-data/province");
  if (res.data?.code !== 200) throw new Error(res.data?.message || "GHN province error");
  return res.data.data || [];
}

/**
 * Fetch GHN districts for a province.
 */
async function getDistricts(provinceId) {
  ensureGhnConfig();
  const res = await ghnDataClient.post("/master-data/district", { province_id: Number(provinceId) });
  if (res.data?.code !== 200) throw new Error(res.data?.message || "GHN district error");
  return res.data.data || [];
}

/**
 * Fetch GHN wards for a district.
 */
async function getWards(districtId) {
  ensureGhnConfig();
  const res = await ghnDataClient.get("/master-data/ward", { params: { district_id: Number(districtId) } });
  if (res.data?.code !== 200) throw new Error(res.data?.message || "GHN ward error");
  return res.data.data || [];
}

/**
 * createShippingOrder
 * @param {Object} order        — Mongoose Order document
 * @param {Object} fromAddress  — Shop pickup address { name, phone, address, district_id, ward_code }
 */
async function createShippingOrder(order, fromAddress) {
  ensureGhnConfig();
  const addr = order.shipping_address || {};

  // Validate required GHN address fields before calling API
  const districtId = Number(addr.district_code || 0);
  const wardCode   = String(addr.ward_code || "").trim();

  if (!districtId) {
    throw new Error(
      "Địa chỉ giao hàng thiếu mã quận/huyện (district_code). " +
      "Khách hàng cần cập nhật địa chỉ với đầy đủ thông tin để sử dụng giao hàng nhanh."
    );
  }
  if (!wardCode) {
    throw new Error(
      "Địa chỉ giao hàng thiếu mã phường/xã (ward_code). " +
      "Khách hàng cần cập nhật địa chỉ với đầy đủ thông tin để sử dụng giao hàng nhanh."
    );
  }

  // Determine payment type:
  // 2 = COD (recipient pays shipper) | 1 = prepaid (shop already paid)
  const isCOD = order.payment_method === "COD";
  const payment_type_id = isCOD ? 2 : 1;
  const cod_amount      = isCOD ? Math.round(order.total_price) : 0;

  // Build items list from order items
  const items = (order.items || []).map((it) => ({
    name:     it.name || "Sản phẩm",
    quantity: it.qty  || 1,
    price:    Math.round(it.price || 0),
    weight:   200,
  }));

  // Pick the best available service type for this from→to district pair.
  // Preference order: 2 (Express) → 5 (Standard) → first available → fallback 2.
  const fromDistrictId = fromAddress?.district_id ? Number(fromAddress.district_id) : 0;
  let serviceTypeId = 2;
  if (fromDistrictId) {
    try {
      const services = await getAvailableServices(fromDistrictId, districtId);
      const preferred = services.find(s => s.service_type_id === 2)
        || services.find(s => s.service_type_id === 5)
        || services[0];
      if (preferred) {
        serviceTypeId = preferred.service_type_id;
        console.log(`[GHN] Using service_type_id: ${serviceTypeId} (${preferred.short_name || ""})`);
      }
    } catch {
      // keep default
    }
  }

  const payload = {
    payment_type_id,
    note:           order.note || "",
    required_note:  "CHOXEMHANGKHONGTHU",
    // Pickup (from) address — each shop's own address
    ...(fromAddress?.district_id && fromAddress?.ward_code ? {
      from_name:        fromAddress.name    || "Shop",
      from_phone:       fromAddress.phone   || "",
      from_address:     fromAddress.address || "",
      from_district_id: Number(fromAddress.district_id),
      from_ward_code:   String(fromAddress.ward_code),
    } : {}),
    // Delivery (to) address
    to_name:        addr.name    || "Khách hàng",
    to_phone:       addr.phone   || "0000000000",
    to_address:     [addr.street, addr.ward, addr.district].filter(Boolean).join(", "),
    to_ward_code:   wardCode,
    to_district_id: districtId,
    cod_amount,
    weight:         500,
    length:         20,
    width:          20,
    height:         10,
    service_type_id: serviceTypeId,
    items,
  };

  if (process.env.NODE_ENV !== "production") {
    console.log(`[GHN] createShippingOrder | order: ${order.order_code} | COD: ${cod_amount}`);
  }

  let response;
  try {
    response = await ghnClient.post("/shipping-order/create", payload);
  } catch (axiosErr) {
    const status  = axiosErr.response?.status;
    const body    = axiosErr.response?.data;
    const headers = axiosErr.response?.headers;
    console.error(`[GHN] HTTP ${status} from GHN API`);
    console.error(`[GHN] Response body:`, JSON.stringify(body, null, 2));
    console.error(`[GHN] Response headers:`, JSON.stringify(headers, null, 2));
    const detail = body?.message || body?.error || axiosErr.message;
    throw new Error(`GHN HTTP ${status}: ${detail}`);
  }

  if (response.data?.code !== 200) {
    const msg = response.data?.message || "GHN API error";
    console.error(`[GHN] createShippingOrder failed | order: ${order.order_code} | msg: ${msg}`);
    console.error(`[GHN] Full response:`, JSON.stringify(response.data, null, 2));

    // Give actionable hints for common GHN errors
    if (/address|pick.?up|store|kho/i.test(msg)) {
      throw new Error(`GHN: ${msg} — Vui lòng thiết lập địa chỉ lấy hàng mặc định tại 5sao.ghn.dev → Cài đặt → Địa chỉ lấy hàng.`);
    }
    if (/shop.*not.*exist|không.*tìm.*thấy.*shop/i.test(msg)) {
      throw new Error(`GHN: ${msg} — Kiểm tra lại GHN_SHOP_ID trong file .env.`);
    }
    throw new Error(`GHN: ${msg}`);
  }

  console.log(`[GHN] Created | order: ${order.order_code} | ghn_code: ${response.data.data?.order_code}`);
  return response.data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelShippingOrder
// Cancels an existing GHN order.
//
// @param {string} ghnCode — GHN order_code
// ─────────────────────────────────────────────────────────────────────────────
async function cancelShippingOrder(ghnCode) {
  ensureGhnConfig();
  console.log(`[GHN] cancelShippingOrder | ghn_code: ${ghnCode}`);
  const response = await ghnClient.post("/switch-status/cancel", {
    order_codes: [ghnCode],
  });

  if (response.data?.code !== 200) {
    const msg = response.data?.message || "GHN cancel error";
    console.error(`[GHN] cancelShippingOrder failed | ghn_code: ${ghnCode} | msg: ${msg}`);
    throw new Error(`GHN cancel: ${msg}`);
  }

  return response.data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// getOrderDetail
// Retrieves full order detail + tracking logs from GHN.
// Note: GHN uses POST for this endpoint.
//
// @param {string} ghnCode — GHN order_code
// ─────────────────────────────────────────────────────────────────────────────
async function getOrderDetail(ghnCode) {
  ensureGhnConfig();
  const response = await ghnClient.post("/shipping-order/detail", {
    order_code: ghnCode,
  });

  if (response.data?.code !== 200) {
    const msg = response.data?.message || "GHN detail error";
    throw new Error(`GHN detail: ${msg}`);
  }

  return response.data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// getAvailableServices
// Returns available services for a from→to district pair.
// Used to pick the best service_type_id before creating an order.
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableServices(fromDistrictId, toDistrictId) {
  ensureGhnConfig();
  const response = await ghnClient.get("/shipping-order/available-services", {
    params: {
      shop_id:          GHN_SHOP_ID,
      from_district:    Number(fromDistrictId),
      to_district:      Number(toDistrictId),
    },
  });
  if (response.data?.code !== 200) return [];
  return response.data.data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateFee
// Calculates estimated shipping fee for given destination.
//
// @param {Object} opts — { toDistrictId, toWardCode, weight }
// ─────────────────────────────────────────────────────────────────────────────
async function calculateFee({ toDistrictId, toWardCode, weight = 500 }) {
  ensureGhnConfig();
  const response = await ghnClient.get("/shipping-order/fee", {
    params: {
      service_type_id: 2,
      to_district_id:  Number(toDistrictId),
      to_ward_code:    String(toWardCode),
      weight:          Number(weight),
    },
  });

  if (response.data?.code !== 200) {
    const msg = response.data?.message || "GHN fee error";
    throw new Error(`GHN fee: ${msg}`);
  }

  return response.data.data;
}

module.exports = {
  createShippingOrder,
  cancelShippingOrder,
  getOrderDetail,
  mapGhnStatus,
  calculateFee,
  getAvailableServices,
  getProvinces,
  getDistricts,
  getWards,
};
