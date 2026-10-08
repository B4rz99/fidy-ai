-- Bind each one-use protocol attempt to its selected provider.
ALTER TABLE provider_authentication_attempts ADD COLUMN provider TEXT NOT NULL DEFAULT 'google' CHECK(provider IN ('google','microsoft'));
