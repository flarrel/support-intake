CREATE TABLE tickets (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    text text NOT NULL CHECK (char_length(text) <= 4000),
    source text NOT NULL CHECK (source IN ('text', 'image')),
    intent text,
    confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    status text NOT NULL CHECK (status IN ('review', 'routed')),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status = 'review' OR intent IS NOT NULL)
);

CREATE TABLE ticket_reviews (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id integer NOT NULL REFERENCES tickets (id),
    from_intent text,
    to_intent text NOT NULL,
    note text NOT NULL CHECK (char_length(note) <= 500),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tickets_recent ON tickets (created_at DESC, id DESC);
CREATE INDEX tickets_review_queue ON tickets (status, created_at DESC, id DESC);
CREATE INDEX ticket_reviews_by_ticket ON ticket_reviews (ticket_id, id);
