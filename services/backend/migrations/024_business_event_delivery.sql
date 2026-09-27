-- Historical rows have no recoverable mutation-time snapshots. Leave them NULL;
-- only new, frozen collector facts enter the delivery queue. Ratings also stay NULL.
ALTER TABLE business_events ADD COLUMN collector_payload text;
ALTER TABLE business_events ADD COLUMN collector_delivered_at timestamptz;
ALTER TABLE business_events ADD CONSTRAINT business_events_collector_payload
  CHECK (collector_payload IS NULL OR
    (octet_length(collector_payload) <= 114624 AND jsonb_typeof(collector_payload::jsonb) = 'object'));
ALTER TABLE business_events ADD CONSTRAINT business_events_collector_ack
  CHECK (collector_delivered_at IS NULL OR (collector_payload IS NOT NULL AND collector_delivered_at >= created_at));
CREATE INDEX business_events_collector_pending_idx ON business_events(created_at,id)
  WHERE collector_payload IS NOT NULL AND collector_delivered_at IS NULL;

CREATE FUNCTION preserve_business_event_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Never reconstruct old rows from today's ride or change already-frozen facts.
  IF OLD.collector_payload IS DISTINCT FROM NEW.collector_payload OR
    (OLD.collector_payload IS NOT NULL AND
      ROW(OLD.id,OLD.ride_id,OLD.ride_version,OLD.action,OLD.actor_id,OLD.payload,OLD.created_at)
        IS DISTINCT FROM ROW(NEW.id,NEW.ride_id,NEW.ride_version,NEW.action,NEW.actor_id,NEW.payload,NEW.created_at)) OR
    (OLD.collector_delivered_at IS NOT NULL AND OLD.collector_delivered_at IS DISTINCT FROM NEW.collector_delivered_at) THEN
    RAISE EXCEPTION 'Business event delivery facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER business_event_delivery_immutable BEFORE UPDATE ON business_events
  FOR EACH ROW EXECUTE FUNCTION preserve_business_event_delivery();
