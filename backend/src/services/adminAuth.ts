import { timingSafeEqual } from "node:crypto";
import { FastifyRequest } from "fastify";

export function requireAdmin(request: FastifyRequest): void {
  const configuredKey = process.env.ADMIN_API_KEY;
  if (!configuredKey) throw new Error("ADMIN_API_KEY must be configured before admin routes are enabled.");

  const authorization = request.headers.authorization;
  const suppliedKey = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!suppliedKey) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }

  const expected = Buffer.from(configuredKey);
  const actual = Buffer.from(suppliedKey);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
}
