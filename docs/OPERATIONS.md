# AgentVault Operations Guide

## Purpose

AgentVault is a policy-enforced treasury for autonomous agents. It separates an
agent's ability to decide that it wants to buy something from the authority to
move funds. The agent can initiate a spend, but the `AgentTreasury` contract
enforces the organisation's limits before any USDC leaves custody.

AgentVault does not choose counterparties, approve business purpose, or make a
generic cross-chain payment processor out of Moove. It enforces the configured
policy, records the resulting spend event, and the backend performs settlement
only when the counterparty's payment link has the exact token and chain that
the treasury is configured to send.

## System Model

```text
Operator dashboard
  |  authenticated policy and counterparty changes
  v
Render API + Postgres
  |                         ^
  | indexes confirmed events |
  v                         |
AgentTreasury on Base -------+
  | checks balance, cap, allowlist, replay protection
  v
Settlement relayer wallet
  | direct USDC transfer after payment-link validation
  v
Counterparty destination wallet
```

The contract is the source of truth for policy, balances, daily spend totals,
allowed counterparty hashes, and replay protection. Postgres is the source of
truth for the human-readable counterparty mapping, event checkpoint, settlement
state, and operational audit history.

## Spend Lifecycle

1. The operator creates a policy for an agent and registers a counterparty.
2. The API validates the active Moove payment link and writes the identifier to
   Postgres. It then sends `setCounterpartyAllowed(agent, keccak256(identifier), true)`.
3. The agent wallet calls `spend(counterpartyId, amount, requestId)` directly.
4. The contract rejects a spend if the agent has no policy, the counterparty is
   not allowed, its balance is too low, the daily cap is exceeded, or the
   `requestId` was used already.
5. For an approved spend, USDC moves from the contract to the settlement
   relayer, and the contract emits `SpendExecuted`.
6. The backend indexes only confirmed blocks, persists the event with a unique
   `requestId`, and advances its Postgres checkpoint.
7. The worker resolves the counterparty mapping and sends the configured USDC
   from the relayer wallet to the validated destination address.
8. The dashboard displays `pending`, `processing`, `settled`, or an exception
   state. Unknown downstream transfer outcomes are not automatically retried:
   an operator must reconcile them to avoid a double payment.

## Mainnet Scope and Limits

This release supports same-token, same-chain direct ERC-20 settlement only.
For a Base mainnet deployment, that means native Base USDC. Circle lists its
Base mainnet USDC contract as `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
Do not register a Moove link that settles to a different chain or token: the
API rejects it. Cross-chain or cross-token settlement requires a separately
reviewed, authenticated routing integration.

The relayer is a material trust boundary. Once `spend()` executes, funds have
left the treasury contract and are controlled by the relayer. Use a dedicated
wallet, maintain an operational USDC/ETH balance, and use a managed signer or
key-management service before handling meaningful value.

## Production Environment Values

Set these on the Render **agentvault-api** service. Never commit private keys,
database passwords, or `ADMIN_API_KEY`.

| Variable | Production value / source |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `10000` on Render |
| `DATABASE_URL` | Supabase Postgres connection string, from Supabase Connect |
| `DATABASE_SSL` | `true` |
| `DATABASE_POOL_SIZE` | `5` to start; increase only after observing connection use |
| `ADMIN_API_KEY` | 32+ random bytes, e.g. `openssl rand -base64 32` |
| `DASHBOARD_ORIGIN` | Exact deployed dashboard URL, no trailing slash |
| `EVM_RPC_URL` | Dedicated Base mainnet HTTPS RPC URL from an RPC provider |
| `CHAIN_ID` | `8453` for Base mainnet |
| `AGENT_TREASURY_ADDRESS` | Address emitted by the fresh mainnet deployment |
| `OWNER_PRIVATE_KEY` | Key for the deployed contract owner, ideally replaced by managed signing before launch |
| `RELAYER_PRIVATE_KEY` | Key for the exact `settlementRelayer` set in the contract constructor |
| `SETTLEMENT_RPC_URL` | Base mainnet HTTPS RPC URL; may match `EVM_RPC_URL` |
| `SETTLEMENT_TOKEN_ADDRESS` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `SETTLEMENT_CHAIN_ID` | `8453` |
| `CONTRACT_DEPLOYMENT_BLOCK` | Block number of the mainnet deployment transaction |
| `EVENT_CONFIRMATIONS` | `3` initially; increase for a stricter finality policy |
| `EVENT_POLL_INTERVAL_MS` | `12000` |
| `ENABLE_DEMO_SPEND` | `false` on mainnet |

Set these on **agentvault-dashboard** at build time:

| Variable | Value |
| --- | --- |
| `VITE_BACKEND_URL` | Exact public Render API URL, e.g. `https://agentvault-api.onrender.com` |
| `VITE_AGENT_ADDRESS` | Public address of the specific managed agent wallet to display |
| `VITE_ENABLE_DEMO_SPEND` | `false` |

`VITE_*` values are public: do not put an API key, a private key, or a database
value in any dashboard variable.

## Supabase Setup

1. Create a Supabase project in the region closest to the Render API.
2. Open **Connect** in Supabase and copy a Postgres connection string. Use the
   pooler connection if direct connections are unsuitable for your network.
3. Set it as `DATABASE_URL` on Render. Keep `DATABASE_SSL=true`.
4. Deploy the API. Render runs `npm run db:migrate` before it starts the API;
   the migration creates `counterparties`, `spend_events`, and
   `event_checkpoints`.
5. Confirm `GET /ready` returns HTTP 200. A startup failure means the API could
   not validate its database, RPC network, treasury owner, token, or relayer.

The backend uses the portable `pg` driver rather than the Supabase JavaScript
SDK. Supabase provides managed Postgres, backups, and monitoring, while the
application remains portable to another PostgreSQL provider.

## Render Deployment

The included `render.yaml` creates two services from this monorepo:

- `agentvault-api`: paid Render web service. A paid plan is required because
  the Blueprint runs migrations in `preDeployCommand`.
- `agentvault-dashboard`: static Vite site.

1. Push this repository to GitHub or GitLab.
2. In Render, choose **New > Blueprint** and select the repository.
3. Create the Blueprint. Render will create placeholders for secret values.
4. Configure every API variable in the Render Environment page. Set the
   dashboard `VITE_BACKEND_URL` first, deploy the dashboard, copy its URL, and
   then set the same URL as API `DASHBOARD_ORIGIN` before redeploying the API.
5. Deploy the API and wait for its health check at `/health`. Then deploy the
   dashboard again if its API URL changed.
6. Open the dashboard, paste `ADMIN_API_KEY` only into the session field, set
   the agent's daily cap, and register counterparties.

Render serves static Vite variables at build time. Any change to
`VITE_BACKEND_URL` or `VITE_AGENT_ADDRESS` requires a dashboard rebuild.

## Mainnet Launch Checklist

- Deploy a fresh contract to Base mainnet; do not reuse the Sepolia deployment.
- Verify deployed owner, token, and relayer addresses in the block explorer.
- Set the mainnet deployment block accurately.
- Fund the owner wallet with ETH for administrative transactions.
- Fund the relayer wallet with Base ETH for gas and monitor its USDC float.
- Use a small, controlled counterparty link for the first end-to-end payment.
- Configure a dedicated operator API key and restrict who can access it.
- Confirm dashboard origin matches exactly, including `https://`.
- Confirm the API health endpoint and database migration before funding agents.
- Obtain a smart-contract audit and a backend security review before holding
  material user or company funds.

## Incident Handling

- `error` settlement status: inspect the relayer wallet and transaction
  explorer before any manual retry. Do not assume the transfer failed.
- `link_not_found`: correct or replace the counterparty link, then investigate
  the event record before retrying.
- `cross_chain_unsupported`: do not manually substitute an arbitrary address;
  use a compatible payment link or an approved routing process.
- Backend restart: safe. The worker resumes from `event_checkpoints` and
  reuses persisted event records.
- Key compromise: pause the contract, rotate the relevant key, update the
  relayer if required, and investigate outstanding spend events.
