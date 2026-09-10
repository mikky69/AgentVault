create table if not exists counterparties (
  agent_address text not null,
  counterparty_id text not null,
  identifier text not null,
  moove_payment_link_id text not null,
  label text,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agent_address, counterparty_id)
);

create table if not exists spend_events (
  request_id text primary key,
  transaction_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  agent_address text not null,
  counterparty_id text not null,
  amount numeric(78, 0) not null,
  status text not null check (status in (
    'pending', 'processing', 'settled', 'cross_chain_unsupported',
    'link_not_found', 'unresolved_counterparty', 'error'
  )),
  counterparty_label text,
  settlement_tx_hash text,
  error_message text,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (transaction_hash, log_index)
);

create index if not exists spend_events_agent_created_at_idx
  on spend_events (agent_address, created_at desc);
create index if not exists spend_events_retry_idx
  on spend_events (status, next_attempt_at);

create table if not exists event_checkpoints (
  consumer text primary key,
  block_number bigint not null,
  updated_at timestamptz not null default now()
);
