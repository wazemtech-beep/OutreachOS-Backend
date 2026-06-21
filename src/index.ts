import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { leadListRoutes } from "./routes/leads.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { emailAccountRoutes } from "./routes/email-accounts.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { settingsRoutes } from "./routes/settings.js";
import { inboxRoutes } from "./routes/inbox.js";
import "./jobs/index.js"; // Import all workers
import { workerRoutes } from "./routes/workers.js";
import { deliverabilityRoutes } from "./routes/deliverability.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});
await app.register(multipart);

app.get("/", async () => ({ status: "ok", service: "OutreachOS API", version: "1.0.0" }));
app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

await app.register(leadListRoutes, { prefix: "/api/v1" });
await app.register(campaignRoutes, { prefix: "/api/v1" });
await app.register(emailAccountRoutes, { prefix: "/api/v1" });
await app.register(analyticsRoutes, { prefix: "/api/v1" });
await app.register(settingsRoutes, { prefix: "/api/v1" });
await app.register(inboxRoutes, { prefix: "/api/v1" });
await app.register(workerRoutes, { prefix: "/api/v1" });
await app.register(deliverabilityRoutes, { prefix: "/api/v1" });
await app.register(unsubscribeRoutes);

const port = Number(process.env.PORT) || Number(process.env.API_PORT) || 5000;

try {
  await app.listen({ port, host: "::" });
  console.log(`OutreachOS API running on port ${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
