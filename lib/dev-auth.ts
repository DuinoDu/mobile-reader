import "server-only";

import { encryptSecret } from "@/lib/crypto";
import { upsertUserFromConductor } from "@/lib/db";
import type { AppUser } from "@/lib/types";

/**
 * 是否启用「本地开发跳过 SSO」直登模式。
 *
 * - 仅在非生产环境生效（`next dev` 会把 NODE_ENV 设为 "development"）。
 * - 生产构建（`next build` / `next start`）下永远为 false，不影响线上 SSO。
 * - 如需在本地仍走真实 SSO，可设置 DISABLE_DEV_SSO_BYPASS=1 关闭。
 */
export function isDevSsoBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DISABLE_DEV_SSO_BYPASS !== "1"
  );
}

/**
 * 创建（或复用）本地开发用户，绕过 Conductor SSO 令牌交换。
 * 用户信息可通过环境变量覆盖，便于模拟不同账号。
 */
export function getOrCreateDevUser(): AppUser {
  const conductorUserId = process.env.DEV_USER_ID || "dev-local-user";
  return upsertUserFromConductor({
    conductorUserId,
    email: process.env.DEV_USER_EMAIL || "dev@localhost",
    phone: null,
    name: process.env.DEV_USER_NAME || "本地开发用户",
    encryptedConductorToken: encryptSecret("dev-local-bypass-token"),
    conductorBaseUrl: null,
  });
}
