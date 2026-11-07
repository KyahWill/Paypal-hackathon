-- Rule 4: AuditLog is append-only. TRUNCATE stays possible on purpose, because
-- db:reset is how the demo gets wiped.
CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$;

CREATE TRIGGER audit_log_no_update_or_delete
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
