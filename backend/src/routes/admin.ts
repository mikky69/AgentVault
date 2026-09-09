import { FastifyInstance } from "fastify";
import { setAgentPolicy, allowCounterparty } from "../services/treasuryContract.js";

export async function adminRoutes(app: FastifyInstance) {
  app.post<{
    Params: { address: string };
    Body: { dailyCap: string }; // smallest unit, as a string to avoid JS number precision issues
  }>("/agents/:address/policy", async (req, reply) => {
    const { address } = req.params;
    const { dailyCap } = req.body;

    if (!dailyCap) {
      return reply.status(400).send({ error: "dailyCap is required (smallest unit, as a string)" });
    }

    const receipt = await setAgentPolicy(address, BigInt(dailyCap));
    return { ok: true, txHash: receipt?.hash };
  });

  app.post<{
    Params: { address: string };
    // moovePaymentLinkId accepts either a bare id or a full checkout URL
    // (e.g. pasted straight from the counterparty's Moove dashboard) —
    // it's normalized down to the id when stored.
    Body: { identifier: string; moovePaymentLinkId: string; label?: string };
  }>("/agents/:address/counterparties", async (req, reply) => {
    const { address } = req.params;
    const { identifier, moovePaymentLinkId, label } = req.body;

    if (!identifier || !moovePaymentLinkId) {
      return reply.status(400).send({ error: "identifier and moovePaymentLinkId are required" });
    }

    const result = await allowCounterparty(address, identifier, moovePaymentLinkId, label);
    return { ok: true, ...result };
  });
}
