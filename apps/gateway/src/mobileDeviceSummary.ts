import type { GatewayDatabase } from "./database.js";

export class MobileDeviceSummaryRepository {
  constructor(private readonly db: GatewayDatabase) {}

  activePersonalDeviceCount(familyRef: string, personRef: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT d.device_ref) AS count
       FROM managed_devices d
       JOIN device_bindings db
         ON db.device_ref = d.device_ref
        AND db.owner_scope = 'person'
        AND db.family_ref = ?
        AND db.person_ref = ?
        AND db.status = 'active'
       JOIN entry_bindings eb
         ON eb.device_ref = d.device_ref
        AND eb.family_ref = db.family_ref
        AND eb.person_ref = db.person_ref
        AND eb.audience = 'personal'
        AND eb.status = 'active'
       WHERE d.status = 'active'
         AND d.terminal_type = 'mobile'`
    ).get(familyRef, personRef) as { count: number };
    return Number(row.count);
  }
}
