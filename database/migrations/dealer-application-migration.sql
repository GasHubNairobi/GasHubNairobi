-- Run once in Supabase SQL Editor before accepting public dealer applications.
CREATE TABLE IF NOT EXISTS dealer_applications (
  id BIGSERIAL PRIMARY KEY,
  applicant_name VARCHAR(120) NOT NULL,
  business_name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  business_type VARCHAR(80),
  county VARCHAR(100) NOT NULL,
  town VARCHAR(100) NOT NULL,
  address VARCHAR(300) NOT NULL,
  description TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','ignored')),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  account_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dealer_applications_status_created_idx ON dealer_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS dealer_applications_email_idx ON dealer_applications(LOWER(email));
