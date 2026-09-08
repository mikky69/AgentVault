import { FastifyInstance } from "fastify";
import { getAgentStatus } from "../services/treasuryContract.js";
import { getAuditLog } from "../services/auditLog.js";
import { listCounterparties } from "../services/counterpartyRegistry.js";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string } }>("/agents/:address", async (req) => {
    const status = await getAgentStatus(req.params.address);
    const history = getAuditLog(req.params.address);
    return { ...status, history };
  });

  app.get("/audit", async () => {
    return { entries: getAuditLog() };
  });

  app.get("/counterparties", async () => {
    return { entries: listCounterparties() };
  });
}
