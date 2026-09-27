-- TerePay Credit Assessment Agent — schema (PostgreSQL)
-- Assumes loan_applications(id UUID PRIMARY KEY, ...) already exists.
--
-- Optional but recommended: expose TerePay's own repayment history to the assessor as boolean columns (or a view)
-- named after the Borrower Behaviour Scorecard items; the workflow uses them as authoritative scorecard ticks:
--   behaviour_paid_previous_loan_early, behaviour_paid_on_time_consistently, behaviour_communicates_proactively,
--   behaviour_missed_payments_before, behaviour_existing_defaults, behaviour_write_off_history,
--   behaviour_requests_bigger_loan_too_fast, behaviour_provides_multiple_excuses, behaviour_avoids_communication
-- e.g. CREATE VIEW loan_applications_for_assessment AS SELECT a.*, h.* FROM loan_applications a LEFT JOIN customer_behaviour h USING (customer_id);

CREATE TABLE IF NOT EXISTS credit_assessments (
  id                  SERIAL PRIMARY KEY,
  application_id      UUID NOT NULL REFERENCES loan_applications(id),
  triggered_by        VARCHAR(255) NOT NULL,
  -- Spec fields
  risk_rating         VARCHAR(20)  NOT NULL,   -- Low | Medium | High
  recommendation      VARCHAR(20)  NOT NULL,   -- Approve | Deny | Conditional
  confidence_score    INTEGER      NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  factors_json        JSONB,
  reasoning           TEXT,
  evidence_json       JSONB,
  -- Audit / CCCFA s.9CA (retain 7 years)
  expense_risk_tier   VARCHAR(20),             -- Lower | Moderate | High | Critical
  behaviour_score     INTEGER,
  behaviour_tier      VARCHAR(40),
  escalation          VARCHAR(40),             -- none | credit_officer | senior_credit_officer | decline
  rule_hits_json      JSONB,                   -- which thresholds fired, with values
  llm_raw_json        JSONB,                   -- full model output (what the rules were applied to)
  llm_preliminary_view VARCHAR(20),
  model               VARCHAR(100),
  framework_version   VARCHAR(20),
  documents_json      JSONB,                   -- file names + Drive IDs used
  analysis_json       JSONB,                   -- deterministic statement metrics (parsed transactions summary)
  parser_mode         VARCHAR(20),             -- deterministic | fallback | none
  processing_ms       INTEGER,
  n8n_execution_id    VARCHAR(50),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_assessments_app ON credit_assessments(application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assessment_errors (
  id               SERIAL PRIMARY KEY,
  application_id   UUID,
  n8n_execution_id VARCHAR(50),
  workflow_name    VARCHAR(255),
  error_step       VARCHAR(255),
  error_message    TEXT,
  error_stack      TEXT,
  execution_url    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Least-privilege role for n8n
-- CREATE ROLE n8n_assessor LOGIN PASSWORD '...';
-- GRANT SELECT ON loan_applications TO n8n_assessor;
-- GRANT INSERT, SELECT ON credit_assessments, assessment_errors TO n8n_assessor;
-- GRANT USAGE, SELECT ON SEQUENCE credit_assessments_id_seq, assessment_errors_id_seq TO n8n_assessor;
