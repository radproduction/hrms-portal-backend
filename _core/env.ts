export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  serviceApiUrl: process.env.SERVICE_API_URL ?? "",
  serviceApiKey: process.env.SERVICE_API_KEY ?? "",
  officeLat: process.env.OFFICE_LAT ? Number(process.env.OFFICE_LAT) : null,
  officeLng: process.env.OFFICE_LNG ? Number(process.env.OFFICE_LNG) : null,
  officeRadiusKm: process.env.OFFICE_RADIUS_KM ? Number(process.env.OFFICE_RADIUS_KM) : 0.5,
};
