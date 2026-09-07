<img src="dashboard/public/AgentVault.png" alt="AgentVault Logo" width="900"/>

# AgentVault

An autonomous spend controller for AI agents. Each agent gets its own
on-chain balance and a spend policy (daily cap + counterparty allowlist).
When the agent authorizes a payment, AgentTreasury enforces the policy
on-chain, then the backend settles the actual payment through Moove —
so the agent never needs to hold whatever specific token or chain its
counterparty happens to want.

Built for the Moove Developer Program.

## How it works

```
AI Agent (own wallet)
      |
      | spend(counterpartyId, amount, requestId)
      v
AgentTreasury.sol  (Base Sepolia)
  - checks: policy exists, counterparty allowed, within daily cap,
    requestId not reused, sufficient balance
  - moves funds: agent balance -> settlementRelayer address
  - emits: SpendExecuted
      |
      v
Backend event listener (ethers.js)
  - resolves counterpartyId -> real destination (off-chain registry)
  - calls Moove to actually deliver value to that destination
  - records the outcome to the audit log
      |
      v
Dashboard reads /agents/:address and /audit
```

The contract's job is authorization, custody, and an audit trail. Moove's
job is the actual cross-chain/cross-token delivery. The backend is the
glue between the two.

**Why counterparties are hashed identifiers, not addresses:** a
counterparty (an API provider, another agent, a data vendor) may not
exist on Base at all — it might only be reachable through Moove on a
completely different chain. So the contract stores
`keccak256(identifier)` and the backend keeps the only copy of what that
identifier actually resolves to. This is also why registering a
counterparty is one API call that does two things: allow it on-chain,
and store the resolution off-chain.

## Running it

### Contracts

```bash
cd contracts
forge test                      # 11 tests should pass

# Deploy to Base Sepolia:
export DEPLOYER_PRIVATE_KEY=...
export SETTLEMENT_TOKEN=...     # USDC address on Base Sepolia
export SETTLEMENT_RELAYER=...   # address the backend controls
forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --broadcast
```

### Backend

```bash
cd backend
npm install
cp .env.example .env            # fill in RPC URL, contract address, owner key
npm run dev
```

Register an agent's policy and a counterparty:

```bash
curl -X POST localhost:3000/agents/<agentAddress>/policy \
  -H 'content-type: application/json' \
  -d '{"dailyCap": "100000000"}'   # 100 USDC (6 decimals)

curl -X POST localhost:3000/agents/<agentAddress>/counterparties \
  -H 'content-type: application/json' \
  -d '{"identifier": "provider-a", "mooveHandle": "provider-a.moove", "label": "Provider A"}'
```

Once the agent calls `spend()` on-chain directly (from its own wallet),
the listener picks up the event and settles it.

## Suggested milestone split (for the Moove application)

1. **Milestone 1** — AgentTreasury deployed to Base Sepolia + policy
   enforcement demo (this repo's current state, once deployed)
2. **Milestone 2** — real Moove API wired into `mooveClient.ts`, live
   settlement demo end-to-end
3. **Milestone 3** — dashboard UI on top of the existing backend routes