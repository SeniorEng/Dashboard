import { eq, and } from "drizzle-orm";
import { db } from "../lib/db";
import { adminPermissions, type AdminPermissionKey, ADMIN_PERMISSION_KEYS } from "@shared/schema";

export const adminPermissionStorage = {
  async getPermissions(userId: number): Promise<AdminPermissionKey[]> {
    const rows = await db
      .select()
      .from(adminPermissions)
      .where(and(eq(adminPermissions.userId, userId), eq(adminPermissions.granted, true)));

    return rows.map(r => r.permissionKey as AdminPermissionKey);
  },

  async hasPermission(userId: number, permissionKey: AdminPermissionKey): Promise<boolean> {
    const rows = await db
      .select()
      .from(adminPermissions)
      .where(
        and(
          eq(adminPermissions.userId, userId),
          eq(adminPermissions.permissionKey, permissionKey),
          eq(adminPermissions.granted, true)
        )
      );

    return rows.length > 0;
  },

  async setPermissions(userId: number, grantedKeys: AdminPermissionKey[]): Promise<void> {
    await db.delete(adminPermissions).where(eq(adminPermissions.userId, userId));

    if (grantedKeys.length > 0) {
      await db.insert(adminPermissions).values(
        grantedKeys.map(key => ({
          userId,
          permissionKey: key,
          granted: true,
        }))
      );
    }
  },

  async grantAllPermissions(userId: number): Promise<void> {
    await this.setPermissions(userId, [...ADMIN_PERMISSION_KEYS]);
  },
};
