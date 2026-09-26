-- Preserve the original quote, including its unit/conditions. A parsed amount
-- alone must not turn a historical whole-car or unspecified quote into /person.
ALTER TABLE rides ADD COLUMN listed_price_label text;
