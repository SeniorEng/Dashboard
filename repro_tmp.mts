process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@localhost:5432/x";
const mod = await import("./server/services/month-close-scheduler.ts");
const tt = await import("./server/storage/time-tracking.ts");
console.log("facade getAdminMonthClosingReadiness type:", typeof tt.timeTrackingStorage.getAdminMonthClosingReadiness);
console.log("keys count:", Object.keys(tt.timeTrackingStorage).length);
