export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3000";
export const AGENT_ADDRESS = import.meta.env.VITE_AGENT_ADDRESS ?? "";

// AgentTreasury's settlement token is assumed 6 decimals (USDC-style) —
// matches MockUSDC in the contract tests. Change this if you deploy
// against a token with different decimals.
export const TOKEN_DECIMALS = 6;
