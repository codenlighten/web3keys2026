-- Phase 4: incoming-payment detection. Track the output index so a deposit (txid,vout)
-- is recorded/notified exactly once.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vout INTEGER;
