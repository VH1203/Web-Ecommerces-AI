
const User      = require("../models/User");
const Shop      = require("../models/Shop");
const auditLog  = require("../services/auditLogService");
const detection = require("../services/violationDetectionService");

let unbanInterval   = null;
let detectionInterval = null;

async function autoUnban() {
  try {
    const now = new Date();

    // Find users with expired temporary bans
    const expiredUsers = await User.find({
      is_banned: true,
      ban_type: "temporary",
      ban_end: { $lte: now, $ne: null },
    });

    for (const user of expiredUsers) {
      user.status    = "active";
      user.is_banned = false;
      user.ban_type  = null;
      user.ban_reason = null;
      user.ban_start = null;
      user.ban_end   = null;
      user.ban_until = null;
      user.banned_by = null;
      await user.save();

      // Reactivate shop if exists
      const shop = await Shop.findOne({ owner_id: user._id, status: "suspended" });
      if (shop) {
        shop.status = "approved";
        await shop.save();
      }

      auditLog.log({
        actorId: "system",
        action: "user.auto_unban",
        targetCollection: "users",
        targetId: String(user._id),
        metadata: { reason: "ban_expired" },
      });

      console.log(`[AutoUnban] Unbanned user ${user._id} (${user.name})`);
    }

    // Also handle legacy ban_until field
    const legacyExpired = await User.find({
      status: "banned",
      ban_until: { $lte: now, $ne: null },
      is_banned: { $ne: true }, // skip if already handled by new system
    });

    for (const user of legacyExpired) {
      user.status   = "active";
      user.ban_until = null;
      await user.save();
      console.log(`[AutoUnban] Unbanned legacy user ${user._id} (${user.name})`);
    }

    if (expiredUsers.length + legacyExpired.length > 0) {
      console.log(`[AutoUnban] Unbanned ${expiredUsers.length + legacyExpired.length} users`);
    }
  } catch (err) {
    console.error("[AutoUnban] Error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start cron intervals
// ─────────────────────────────────────────────────────────────────────────────
function start() {
  // Auto-unban every 5 minutes
  unbanInterval = setInterval(autoUnban, 5 * 60 * 1000);
  console.log("[ModerationCron] Auto-unban scheduled (every 5 min)");

  // Violation detection every 30 minutes
  detectionInterval = setInterval(() => {
    detection.runAllDetections().catch(err => {
      console.error("[ModerationCron] Detection error:", err.message);
    });
  }, 30 * 60 * 1000);
  console.log("[ModerationCron] Violation detection scheduled (every 30 min)");

  // Run once on startup (delayed 30s to let DB connect)
  setTimeout(() => {
    autoUnban().catch(() => {});
  }, 30000);
}

function stop() {
  if (unbanInterval) clearInterval(unbanInterval);
  if (detectionInterval) clearInterval(detectionInterval);
  unbanInterval = null;
  detectionInterval = null;
  console.log("[ModerationCron] Stopped");
}

module.exports = { start, stop, autoUnban };
