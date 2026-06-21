export const config = {
  api: {
    port: Number(process.env.API_PORT) || 5000,
    host: process.env.API_HOST || "0.0.0.0",
    get url() { return process.env.API_URL || `http://localhost:${this.port}`; },
    get apiUrl() { return `${this.url}/api/v1`; },
  },
  frontend: {
    port: Number(process.env.FRONTEND_PORT) || 3000,
    get url() { return process.env.FRONTEND_URL || 'http://localhost:3000'; },
  },
  database: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/outreachos?schema=public",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  tracking: {
    get apiUrl() { return process.env.TRACKING_API_URL || `${config.api.url}/api/v1`; },
  },
  email: {
    defaultFromName: process.env.DEFAULT_FROM_NAME || "User",
    defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || "user@outreachos.local",
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY || "",
  },
};

export default config;
