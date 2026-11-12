-- MCP Events: the webhook subscriptions that an outside assistant makes through events/subscribe.

-- One row per subscription. id is a hash of (token, callback_url, event, arguments), so the same
-- request always addresses the same row. token is the connector token that made the subscription.
CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  event TEXT NOT NULL,
  -- The subscription arguments with their defaults, as canonical JSON.
  arguments TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  -- The Standard Webhooks signing secret (whsec_...), which the subscriber supplies.
  secret TEXT NOT NULL,
  -- The secret before the last rotation. Deliveries carry both signatures until prev_secret_until.
  prev_secret TEXT,
  prev_secret_until TEXT,
  -- When the callback last echoed a verification challenge for this token.
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_delivery_at TEXT,
  -- 'delivered', or why the last delivery failed: timeout, connection_refused, http_4xx, http_5xx, blocked.
  last_status TEXT
);
CREATE INDEX event_subscriptions_token ON event_subscriptions (token, callback_url);
