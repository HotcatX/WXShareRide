ALTER TABLE public_statistics ADD COLUMN coverage_text text
  CHECK (coverage_text IS NULL OR (length(coverage_text) <= 120 AND coverage_text !~ '[[:cntrl:]]'));
