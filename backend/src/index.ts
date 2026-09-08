import "dotenv/config";
import Fastify from "fastify";
import { adminRoutes } from "./routes/admin.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { startSpendListener } from "./services/treasuryContract.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "agentvault-backend" }));

await app.register(adminRoutes);
await app.register(dashboardRoutes);

const PORT = Number(process.env.PORT ?? 3000);

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

// Only start watching for on-chain events once RPC + contract address are
// actually configured — lets the API boot for local route testing even
// before a contract is deployed.
if (process.env.BASE_SEPOLIA_RPC_URL && process.env.AGENT_TREASURY_ADDRESS) {
  startSpendListener();
} else {
  app.log.warn(
    "BASE_SEPOLIA_RPC_URL / AGENT_TREASURY_ADDRESS not set — skipping on-chain event listener. " +
      "Admin/dashboard routes that touch the contract will error until these are set."
  );
}
