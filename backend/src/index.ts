import "dotenv/config";
import Fastify from "fastify";
import { adminRoutes } from "./routes/admin.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { demoRoutes } from "./routes/demo.js";
import { startSpendListener, validateTreasuryConfiguration } from "./services/treasuryContract.js";
import { checkDatabase } from "./services/database.js";

const app = Fastify({ logger: true });

const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "http://localhost:5173";
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin === dashboardOrigin) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }

  if (req.method === "OPTIONS") {
    return reply.status(204).send();
  }
});

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  const aggregateErrors = error instanceof AggregateError ? error.errors : [];
  const detail = aggregateErrors
    .map((entry) => entry instanceof Error ? entry.message : String(entry))
    .filter(Boolean)
    .join("; ");
  const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
  const isProduction = process.env.NODE_ENV === "production";
  reply.status(statusCode).send({ error: isProduction && statusCode >= 500 ? "The request could not be completed" : error.message || detail || "The treasury request failed" });
});

app.get("/health", async () => ({ ok: true, service: "agentvault-backend" }));
app.get("/ready", async () => ({ ok: true, service: "agentvault-backend", ready: true }));

await app.register(adminRoutes);
await app.register(dashboardRoutes);
await app.register(demoRoutes);

const PORT = Number(process.env.PORT ?? 3001);

await checkDatabase();
await validateTreasuryConfiguration();
await startSpendListener();
await app.listen({ port: PORT, host: "0.0.0.0" });
