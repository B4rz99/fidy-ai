-- Local Compose only: create the restricted login before application migrations grant it access.
-- NOFLUID Throwaway credential for the localhost-bound development database.
CREATE ROLE fidy_runtime
  LOGIN PASSWORD 'fidy_runtime'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON DATABASE fidy FROM PUBLIC;
