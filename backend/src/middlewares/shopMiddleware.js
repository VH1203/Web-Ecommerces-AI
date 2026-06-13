const Shop = require("../models/Shop");

/**
 * requireShopOwner
 * Resolves req.shop for the authenticated user.
 * - Finds an approved Shop where owner_id === req.userId
 * - Sets req.shop on success; 403 otherwise
 *
 * Must be used AFTER verifyToken.
 */
exports.requireShopOwner = async (req, res, next) => {
  try {
    const roleName = req.acl?.role_name || req.user?.role_name;
    const isSystemAdmin = roleName === "system_admin" || req.acl?.permissions?.includes?.("all:*");

    let shop = await Shop.findOne({ owner_id: req.userId, status: "approved" }).lean();

    if (!shop && isSystemAdmin) {
      const requestedShopId = req.get("x-shop-id") || req.query.shop_id || req.body?.shop_id;
      if (requestedShopId) {
        shop = await Shop.findOne({ _id: requestedShopId, status: "approved" }).lean();
      }
    }
    if (!shop) {
      return res.status(403).json({
        message: "Bạn chưa có shop hoặc shop chưa được duyệt. Vui lòng đăng ký và chờ duyệt.",
      });
    }
    req.shop = shop;
    next();
  } catch (err) {
    next(err);
  }
};
