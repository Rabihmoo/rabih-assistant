-- =====================================================
-- Run this in Supabase SQL Editor to create all tables
-- Go to: Supabase Dashboard > SQL Editor > New Query
-- Paste this entire file and click RUN
-- =====================================================

-- Contacts book
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  email TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled tasks (delayed actions)
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  run_at TIMESTAMPTZ NOT NULL,
  description TEXT DEFAULT '',
  done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Task / to-do manager
CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  due_date TEXT,
  category TEXT DEFAULT 'general',
  done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Invoice tracking
CREATE TABLE IF NOT EXISTS invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'USD',
  due_date TEXT,
  description TEXT DEFAULT '',
  business TEXT DEFAULT 'Rabih Group',
  paid BOOLEAN DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- WhatsApp message logs (incoming from others)
CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_number TEXT,
  from_name TEXT DEFAULT '',
  message TEXT,
  direction TEXT DEFAULT 'incoming',
  replied BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Checklists — templates (what to send, when, to whom)
CREATE TABLE IF NOT EXISTS checklists (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business TEXT NOT NULL,
  type TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  send_time TEXT NOT NULL,
  manager_number TEXT NOT NULL,
  frequency TEXT DEFAULT 'daily',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Checklist sends — daily records of checklists that were sent
CREATE TABLE IF NOT EXISTS checklist_sends (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  checklist_id UUID REFERENCES checklists(id),
  manager_number TEXT NOT NULL,
  business TEXT NOT NULL,
  type TEXT NOT NULL,
  items JSONB DEFAULT '[]',
  status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  followup_sent BOOLEAN DEFAULT FALSE,
  escalated BOOLEAN DEFAULT FALSE
);

-- Checklist responses — manager replies
CREATE TABLE IF NOT EXISTS checklist_responses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  checklist_id UUID REFERENCES checklists(id),
  send_id UUID REFERENCES checklist_sends(id),
  responder_number TEXT NOT NULL,
  business TEXT DEFAULT '',
  type TEXT DEFAULT '',
  response TEXT NOT NULL,
  photo_url TEXT,
  status TEXT DEFAULT 'received',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pending meeting requests
CREATE TABLE IF NOT EXISTS pending_meetings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  requester_name TEXT NOT NULL,
  requester_number TEXT NOT NULL,
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'waiting',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily API usage tracking
CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL,
  haiku_calls INTEGER DEFAULT 0,
  sonnet_calls INTEGER DEFAULT 0,
  estimated_cost NUMERIC(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts USING btree (name);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_run_at ON scheduled_tasks USING btree (run_at) WHERE done = false;
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks USING btree (done);
CREATE INDEX IF NOT EXISTS idx_invoices_paid ON invoices USING btree (paid);
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_created ON whatsapp_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_checklists_active ON checklists USING btree (active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_checklist_sends_status ON checklist_sends USING btree (status, sent_at);
CREATE INDEX IF NOT EXISTS idx_checklist_sends_date ON checklist_sends USING btree (sent_at);
CREATE INDEX IF NOT EXISTS idx_checklist_responses_send ON checklist_responses USING btree (send_id);
