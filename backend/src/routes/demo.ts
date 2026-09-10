import { FastifyInstance } from "fastify";
import { requireAdmin } from "../services/adminAuth.js";
import { submitDemoSpend } from "../services/treasuryContract.js";

export async function demoRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => {
    requireAdmin(request);
    if (process.env.ENABLE_DEMO_SPEND !== "true") {
      const error = new Error("Demo spend signing is disabled. Agents must submit their own production spends.");
      (error as Error & { statusCode: number }).statusCode = 403;
      throw error;
    }
  });

  app.post<{
    Body: { counterpartyIdentifier?: string; amount?: string };
  }>("/demo/spend", async (req, reply) => {
    const { counterpartyIdentifier, amount } = req.body ?? {};

    if (!counterpartyIdentifier || !amount) {
      return reply.status(400).send({ error: "counterpartyIdentifier and amount are required" });
    }

    let amountSmallestUnit: bigint;
    try {
      amountSmallestUnit = BigInt(amount);
    } catch {
      return reply.status(400).send({ error: "amount must be an integer string in the token's smallest unit" });
    }

    if (amountSmallestUnit <= 0n) {
      return reply.status(400).send({ error: "amount must be greater than zero" });
    }

    const agentPrivateKey = process.env.DEMO_AGENT_PRIVATE_KEY;
    if (!agentPrivateKey) {
      return reply.status(503).send({ error: "DEMO_AGENT_PRIVATE_KEY is not configured" });
    }

    const result = await submitDemoSpend(agentPrivateKey, counterpartyIdentifier, amountSmallestUnit);
    return { ok: true, ...result };
  });
}
