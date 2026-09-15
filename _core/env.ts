export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  serviceApiUrl: process.env.SERVICE_API_URL ?? "",
  serviceApiKey: process.env.SERVICE_API_KEY ?? "",
  officeLat: process.env.OFFICE_LAT ? Number(process.env.OFFICE_LAT) : null,
  officeLng: process.env.OFFICE_LNG ? Number(process.env.OFFICE_LNG) : null,
  officeRadiusKm: process.env.OFFICE_RADIUS_KM ? Number(process.env.OFFICE_RADIUS_KM) : 0.5,
  wingmanUrl: process.env.WINGMAN_URL ?? "",
  /** Company endpoint Wingman gives for forwarding employee notifications. */
  wingmanNotifyUrl: process.env.WINGMAN_NOTIFY_URL ?? "",
  wingmanSecret: process.env.WINGMAN_SECRET ?? "",
  /** Employee id or email Wingman clocks when a request names nobody. */
  wingmanDefaultEmployee: process.env.WINGMAN_DEFAULT_EMPLOYEE ?? "",
  /** How long to wait on Wingman's webhook before giving up. */
  wingmanTimeoutMs:
    Number(process.env.WINGMAN_WEBHOOK_TIMEOUT_MS) > 0
      ? Number(process.env.WINGMAN_WEBHOOK_TIMEOUT_MS)
      : 5000,
};
