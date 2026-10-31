-- V1__init.sql: initial schema
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    full_name   VARCHAR(255),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users (email);

-- Orders belong to users
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users (id),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    status      VARCHAR(32) NOT NULL DEFAULT 'open'
);

ALTER TABLE orders
    ADD COLUMN placed_at TIMESTAMPTZ;

CREATE VIEW open_orders AS
SELECT o.id, u.email, o.total_cents
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'open';

INSERT INTO users (email, full_name) VALUES ('ada@example.com', 'Ada; Lovelace');
INSERT INTO users (email, full_name) VALUES ('grace@example.com', 'Grace Hopper');
INSERT INTO users (email, full_name) VALUES ('linus@example.com', 'Linus Torvalds');

DROP TABLE IF EXISTS legacy_users;
