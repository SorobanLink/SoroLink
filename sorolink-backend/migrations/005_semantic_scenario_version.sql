-- Issue #42: scenario versions are semantic version strings (e.g. "1.0.0").
-- Existing integer run versions N are preserved as "N.0.0".
ALTER TABLE runs
  ALTER COLUMN scenario_version TYPE text
  USING CASE WHEN scenario_version IS NULL THEN NULL ELSE scenario_version::text || '.0.0' END;
