<img src="dashboard/src/assets/AgentVault.png" alt="AgentVault Logo" width="900"/>

# AgentVault

An autonomous spend controller for AI agents. Each agent gets its own
on-chain balance and a spend policy (daily cap + counterparty allowlist).
When the agent authorizes a payment, AgentTreasury enforces the policy
on-chain, then the backend settles the payment against the counterparty's
own Moove payment link.

Built for the Moove Developer Program.

## How it works

```
AI Agent (own wallet)
      |
      | spend(counterpartyId, amount, requestId)
      v
AgentTreasury.sol  (configured EVM network)
  - checks: policy exists, counterparty allowed, within daily cap,
    requestId not reused, sufficient balance
  - moves funds: agent balance -> settlementRelayer address
  - emits: SpendExecuted
      |
      v
Backend event worker (ethers.js + Postgres)
  - resolves counterpartyId -> the counterparty's own Moove payment link id
  - fetches that link's public data (GET /v1/payment-link/{id}, no auth needed)
  - if the link's token+chain match what the treasury holds: relayer sends
    an ERC20 transfer straight to the link's destinationAddress
  - if they don't match: recorded honestly as cross_chain_unsupported —
    Moove Send/Swap/Bridge have no API yet, so there is no live automated
    way to deliver a different asset/chain
      |
      v
Dashboard (React/Vite, terminal-style) polls the selected agent status and
its persisted counterparty and settlement history
```

**Why the settlement leg works this way, not as a generic "pay Moove"
call:** Moove's live API today is receive-only — you can create/list your
own payment links, and anyone can read a link's public data with no auth,
but there is no endpoint that lets you tell Moove "pay someone else."
A payment link always settles to its owner's own default wallet. So the
only real, live automation available is: read a counterparty's link,
and if what we're holding already matches what it wants (same token,
same chain), send it directly — which is exactly what Moove's own
checkout does for a same-asset payer, fee-free. Anything cross-chain or
cross-token has no live automated path yet; `mooveClient.ts` reports that
case explicitly rather than faking success.

**Why counterparties are hashed identifiers, not addresses:** a
counterparty may not exist on Base at all — it's reachable only through
whatever chain its own Moove payment link settles on. So the contract
stores `keccak256(identifier)` and the backend keeps the only copy of
which payment link that identifier actually resolves to. This is also
why registering a counterparty is one API call that does two things:
allow it on-chain, and store the link id off-chain.

## Repo layout

```
contracts/   Foundry project — AgentTreasury.sol, tests, deploy script
backend/     Fastify service — admin API, dashboard API, event listener, Moove client
dashboard/   React/Vite terminal-style monitor — single-agent view, live activity log, command line
```

## Running it

### Contracts

```bash
cd contracts
forge test                      # 11 tests should pass

# Deploy to the intended network:
export DEPLOYER_PRIVATE_KEY=...
export SETTLEMENT_TOKEN=...     # USDC address on the deployment chain
export SETTLEMENT_RELAYER=...   # address the backend controls
forge script script/Deploy.s.sol:Deploy --rpc-url <mainnet-rpc-alias-or-url> --broadcast
```

### Backend

```bash
cd backend
npm install
cp .env.example .env            # fill in the deployment and wallet settings
npm run db:migrate              # apply Postgres schema before the API starts
npm run dev
```

For production, create a Supabase project and use its direct Postgres
connection string for `DATABASE_URL`. The service uses standard Postgres
through `pg`, so it is portable to Neon, RDS, or a self-hosted database.
`DATABASE_URL` must use the database password from Supabase, never the
browser-facing Supabase anon key.

Set `ADMIN_API_KEY` to a high-entropy secret. All policy and counterparty
administration calls require `Authorization: Bearer <ADMIN_API_KEY>`.

Register an agent's policy and a counterparty. `moovePaymentLinkId`
accepts either the bare id or the full checkout URL the counterparty
shares from their own Moove dashboard:

```bash
curl -X POST localhost:3001/agents/<agentAddress>/policy \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'content-type: application/json' \
  -d '{"dailyCap": "100000000"}'   # 100 USDC (6 decimals)

curl -X POST localhost:3001/agents/<agentAddress>/counterparties \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'content-type: application/json' \
  -d '{"identifier": "provider-a", "moovePaymentLinkId": "https://www.moove.xyz/@provider-a/pay/0c8f2e5a-...", "label": "Provider A"}'
```

Once the agent calls `spend()` on-chain directly (from its own wallet),
the listener picks up the event, looks up that payment link, and settles
it directly if the asset matches.

Set `CONTRACT_DEPLOYMENT_BLOCK` to the deployment transaction's block. The
worker waits for `EVENT_CONFIRMATIONS`, persists every `SpendExecuted` event
and an indexing checkpoint in Postgres, then settles pending events with
idempotent records and safe retry backoff. Unknown downstream transfer outcomes
are held for reconciliation instead of being automatically retried. This
prevents an API restart from forgetting a counterparty or skipping an event.

### Dashboard

```bash
cd dashboard
npm install
cp .env.example .env    # set VITE_AGENT_ADDRESS to the funded agent wallet
npm run dev             # http://localhost:5173
```

The dashboard manages the selected agent's daily cap and counterparties. Paste
`ADMIN_API_KEY` into the Operator API key field only for the active browser
session; it is not written to browser storage. Counterparty registration first
validates that the linked Moove payment link is active and uses the configured
settlement token and chain. Revoking a counterparty updates both the on-chain
allowlist and the durable registry.

The dashboard command-line demo is disabled by default and must stay disabled
on mainnet. Production agents sign `spend()` with their own wallet; the backend
does not accept a browser request that signs with an agent private key.
