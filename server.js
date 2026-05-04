const express = require('express');
const session = require('express-session');
let FileStore;
try { FileStore = require('session-file-store')(session); } catch(e) { FileStore = null; }
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const initSqlJs = require('sql.js');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'kvm.db');

let db;

function saveDb() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function run(sql, params=[]) { db.run(sql, params); saveDb(); }
function get(sql, params=[]) { const s=db.prepare(sql); s.bind(params); if(s.step()){const r=s.getAsObject();s.free();return r;} s.free();return null; }
function all(sql, params=[]) { const s=db.prepare(sql); s.bind(params); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; }
function runGetId(sql, params=[]) { db.run(sql,params); const r=get('SELECT last_insert_rowid() as id'); saveDb(); return r?r.id:null; }
function nowStr() { return new Date().toISOString().replace('T',' ').split('.')[0]; }

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function sendPtoEmail(toEmail, toName, status, req) {
  try {
    const settings = getSettings();
    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) return;
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.office365.com',
      port: parseInt(settings.smtp_port) || 587,
      secure: false,
      auth: { user: settings.smtp_user, pass: settings.smtp_pass },
      tls: { rejectUnauthorized: false }
    });
    const isApproved = status === 'approved';
    const subject = isApproved ? 'Your PTO Request Has Been Approved' : 'Your PTO Request Has Been Denied';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #ddd">
        <div style="background:#0d0d0d;padding:20px 24px;border-bottom:3px solid #c0392b;display:flex;align-items:center;gap:12px">
          <span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span>
        </div>
        <div style="padding:28px 24px;background:#ffffff">
          <h2 style="color:${isApproved?'#27ae60':'#7a5010'};margin:0 0 16px">${subject}</h2>
          <p style="margin:0 0 12px">Hi ${toName},</p>
          <p style="margin:0 0 12px">Your time off request has been <strong>${status}</strong>:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
            <tr style="background:#f5f5f5"><td style="padding:8px 12px;font-weight:bold">Dates</td><td style="padding:8px 12px">${req.start_date} – ${req.end_date}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold">Days</td><td style="padding:8px 12px">${req.days} business day${req.days!==1?'s':''}</td></tr>
            <tr style="background:#f5f5f5"><td style="padding:8px 12px;font-weight:bold">Type</td><td style="padding:8px 12px">${req.type}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold">Status</td><td style="padding:8px 12px;color:${isApproved?'#27ae60':'#7a5010'};font-weight:bold;text-transform:uppercase">${status}</td></tr>
          </table>
          ${!isApproved?'<p style="margin:12px 0">Please speak with your manager if you have questions about this decision.</p>':'<p style="margin:12px 0">Enjoy your time off!</p>'}
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
          <p style="font-size:12px;color:#999;margin:0">KVM Door Systems Employee Portal &mdash; This is an automated message, please do not reply.</p>
        </div>
      </div>`;
    await transporter.sendMail({ from:`"${settings.smtp_from_name||'KVM Door Systems'}" <${settings.smtp_user}>`, to: toEmail, subject, html });
    console.log('  PTO email sent to', toEmail);
  } catch(e) { console.error('  Email error:', e.message); }
}

function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  return s;
}

// ─── DB INIT ─────────────────────────────────────────────────────────────────
async function initDb() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    role TEXT DEFAULT '', department TEXT DEFAULT '',
    oncall_dept TEXT DEFAULT '',
    oncall_role TEXT DEFAULT '',
    paired_with INTEGER DEFAULT 0,
    phone TEXT DEFAULT '', email TEXT DEFAULT '',
    is_admin INTEGER DEFAULT 0,
    pto_total INTEGER DEFAULT 10, pto_left INTEGER DEFAULT 10,
    avatar_color TEXT DEFAULT '#7a5010',
    hire_date TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, priority TEXT DEFAULT 'normal', author_name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT DEFAULT 'General', author_name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS oncall (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT DEFAULT '', phone TEXT NOT NULL, department TEXT DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pto_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, type TEXT DEFAULT 'Vacation', notes TEXT DEFAULT '', days INTEGER NOT NULL, status TEXT DEFAULT 'pending', submitted_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS blackouts (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_type TEXT NOT NULL,
    minutes_late INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    logged_by TEXT DEFAULT 'system',
    quarter TEXT DEFAULT '',
    year INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS callins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    call_in_date TEXT NOT NULL,
    call_in_type TEXT NOT NULL DEFAULT 'Sick',
    notes TEXT DEFAULT '',
    notified INTEGER DEFAULT 0,
    logged_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance_recognition (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    quarter TEXT NOT NULL,
    year INTEGER NOT NULL,
    announced INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS timeclock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    clock_type TEXT NOT NULL DEFAULT 'shop',
    status TEXT NOT NULL DEFAULT 'in',
    clock_in TEXT,
    clock_out TEXT,
    latitude_in REAL,
    longitude_in REAL,
    latitude_out REAL,
    longitude_out REAL,
    job_name TEXT DEFAULT '',
    customer_name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    is_union INTEGER DEFAULT 0,
    is_offsite INTEGER DEFAULT 0,
    total_minutes INTEGER DEFAULT 0,
    week_start TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon TEXT DEFAULT '🏆',
    awarded_by TEXT NOT NULL,
    awarded_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS geofence_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS employee_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    doc_name TEXT NOT NULL,
    doc_type TEXT DEFAULT 'other',
    expiry_date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_data TEXT DEFAULT '',
    file_type TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS company_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT DEFAULT 'other',
    description TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_data TEXT DEFAULT '',
    file_type TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    customer_type TEXT DEFAULT 'End User',
    is_partner_company INTEGER DEFAULT 0,
    qb_customer_id TEXT DEFAULT '',
    billing_address TEXT DEFAULT '',
    billing_city TEXT DEFAULT '',
    billing_state TEXT DEFAULT '',
    billing_zip TEXT DEFAULT '',
    billing_email TEXT DEFAULT '',
    billing_phone TEXT DEFAULT '',
    billing_fax TEXT DEFAULT '',
    credit_terms TEXT DEFAULT 'Net 30',
    tax_exempt INTEGER DEFAULT 0,
    tax_exempt_number TEXT DEFAULT '',
    union_required INTEGER DEFAULT 0,
    requires_certified_payroll INTEGER DEFAULT 0,
    partner_labor_rate_notes TEXT DEFAULT '',
    partner_billing_hours INTEGER DEFAULT 0,
    partner_work_order_instructions TEXT DEFAULT '',
    partner_checkin_instructions TEXT DEFAULT '',
    partner_billing_email TEXT DEFAULT '',
    partner_billing_notes TEXT DEFAULT '',
    service_address TEXT DEFAULT '',
    service_city TEXT DEFAULT '',
    service_state TEXT DEFAULT '',
    service_zip TEXT DEFAULT '',
    service_email TEXT DEFAULT '',
    alt_contact_name TEXT DEFAULT '',
    alt_contact_phone TEXT DEFAULT '',
    sms_number TEXT DEFAULT '',
    credit_limit REAL DEFAULT 0,
    price_level TEXT DEFAULT '',
    map_code TEXT DEFAULT '',
    internal_notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    assigned_salesperson_id INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  ['service_address','service_city','service_state','service_zip','service_email','alt_contact_name','alt_contact_phone','sms_number','credit_limit','price_level','map_code'].forEach(col=>{try{db.run(`ALTER TABLE customers ADD COLUMN ${col} TEXT DEFAULT ''`);}catch(e){}});
  db.run(`CREATE TABLE IF NOT EXISTS customer_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    site_name TEXT DEFAULT '',
    store_number TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    site_notes TEXT DEFAULT '',
    access_instructions TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS customer_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    site_id INTEGER DEFAULT 0,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    title TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    phone2 TEXT DEFAULT '',
    email TEXT DEFAULT '',
    is_primary INTEGER DEFAULT 0,
    is_billing_contact INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS customer_equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    site_id INTEGER DEFAULT 0,
    equipment_type TEXT DEFAULT '',
    manufacturer TEXT DEFAULT '',
    model TEXT DEFAULT '',
    serial_number TEXT DEFAULT '',
    size TEXT DEFAULT '',
    install_date TEXT DEFAULT '',
    last_service_date TEXT DEFAULT '',
    warranty_expiry TEXT DEFAULT '',
    condition TEXT DEFAULT '',
    location_in_site TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS partner_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    doc_type TEXT DEFAULT '',
    doc_name TEXT NOT NULL,
    file_name TEXT DEFAULT '',
    file_data TEXT DEFAULT '',
    file_type TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS job_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix TEXT NOT NULL,
    job_number TEXT UNIQUE NOT NULL,
    sequence INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS qb_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type TEXT DEFAULT '',
    records_synced INTEGER DEFAULT 0,
    status TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS oncall_rotation (id INTEGER PRIMARY KEY AUTOINCREMENT, department TEXT NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL)`);

  // ─── QUOTES TABLE ─────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_number TEXT DEFAULT '',
    rep_id INTEGER NOT NULL,
    rep_name TEXT NOT NULL,
    client_name TEXT DEFAULT '',
    contact_name TEXT DEFAULT '',
    address TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    project_name TEXT DEFAULT '',
    scope_summary TEXT DEFAULT '',
    scopes TEXT DEFAULT '[]',
    options TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    subtotal TEXT DEFAULT '',
    tax TEXT DEFAULT '',
    total TEXT DEFAULT '',
    valid_for TEXT DEFAULT '30 days',
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  saveDb();

  // Migrations
  try { db.run(`ALTER TABLE users ADD COLUMN role_type TEXT DEFAULT 'technician'`); saveDb(); } catch(e){}
  try { db.run(`UPDATE users SET role_type='global_admin' WHERE is_admin=1 AND (role_type IS NULL OR role_type='')`); saveDb(); } catch(e){}
  try { db.run(`UPDATE users SET role_type='technician' WHERE is_admin=0 AND (role_type IS NULL OR role_type='')`); saveDb(); } catch(e){}
  ['oncall_dept','oncall_role','paired_with','hire_date'].forEach(col => {
    try { db.run(`ALTER TABLE users ADD COLUMN ${col} TEXT DEFAULT ''`); saveDb(); } catch(e){}
  });
  try { db.run(`ALTER TABLE oncall ADD COLUMN department TEXT DEFAULT ''`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_name TEXT NOT NULL, customer_type TEXT DEFAULT 'End User', is_partner_company INTEGER DEFAULT 0, qb_customer_id TEXT DEFAULT '', billing_address TEXT DEFAULT '', billing_city TEXT DEFAULT '', billing_state TEXT DEFAULT '', billing_zip TEXT DEFAULT '', billing_email TEXT DEFAULT '', billing_phone TEXT DEFAULT '', billing_fax TEXT DEFAULT '', credit_terms TEXT DEFAULT 'Net 30', tax_exempt INTEGER DEFAULT 0, tax_exempt_number TEXT DEFAULT '', union_required INTEGER DEFAULT 0, requires_certified_payroll INTEGER DEFAULT 0, partner_labor_rate_notes TEXT DEFAULT '', partner_billing_hours INTEGER DEFAULT 0, partner_work_order_instructions TEXT DEFAULT '', partner_checkin_instructions TEXT DEFAULT '', partner_billing_email TEXT DEFAULT '', partner_billing_notes TEXT DEFAULT '', internal_notes TEXT DEFAULT '', status TEXT DEFAULT 'active', assigned_salesperson_id INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customer_sites (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, site_name TEXT DEFAULT '', store_number TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '', site_notes TEXT DEFAULT '', access_instructions TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customer_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, site_id INTEGER DEFAULT 0, first_name TEXT NOT NULL, last_name TEXT DEFAULT '', title TEXT DEFAULT '', phone TEXT DEFAULT '', phone2 TEXT DEFAULT '', email TEXT DEFAULT '', is_primary INTEGER DEFAULT 0, is_billing_contact INTEGER DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customer_equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, site_id INTEGER DEFAULT 0, equipment_type TEXT DEFAULT '', manufacturer TEXT DEFAULT '', model TEXT DEFAULT '', serial_number TEXT DEFAULT '', size TEXT DEFAULT '', install_date TEXT DEFAULT '', last_service_date TEXT DEFAULT '', warranty_expiry TEXT DEFAULT '', condition TEXT DEFAULT '', location_in_site TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS partner_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, doc_type TEXT DEFAULT '', doc_name TEXT NOT NULL, file_name TEXT DEFAULT '', file_data TEXT DEFAULT '', file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0, notes TEXT DEFAULT '', uploaded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS job_numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, prefix TEXT NOT NULL, job_number TEXT UNIQUE NOT NULL, sequence INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS qb_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, sync_type TEXT DEFAULT '', records_synced INTEGER DEFAULT 0, status TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, event_date TEXT NOT NULL, event_type TEXT NOT NULL, minutes_late INTEGER DEFAULT 0, notes TEXT DEFAULT '', logged_by TEXT DEFAULT 'system', quarter TEXT DEFAULT '', year INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS callins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, call_in_date TEXT NOT NULL, call_in_type TEXT NOT NULL DEFAULT 'Sick', notes TEXT DEFAULT '', notified INTEGER DEFAULT 0, logged_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS attendance_recognition (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, quarter TEXT NOT NULL, year INTEGER NOT NULL, announced INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS achievements (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', icon TEXT DEFAULT '🏆', awarded_by TEXT NOT NULL, awarded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS timeclock (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, clock_type TEXT NOT NULL DEFAULT 'shop', status TEXT NOT NULL DEFAULT 'in', clock_in TEXT, clock_out TEXT, latitude_in REAL, longitude_in REAL, latitude_out REAL, longitude_out REAL, job_name TEXT DEFAULT '', customer_name TEXT DEFAULT '', notes TEXT DEFAULT '', is_union INTEGER DEFAULT 0, is_offsite INTEGER DEFAULT 0, total_minutes INTEGER DEFAULT 0, week_start TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS geofence_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, alert_type TEXT NOT NULL, latitude REAL, longitude REAL, resolved INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS employee_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, doc_name TEXT NOT NULL, doc_type TEXT DEFAULT 'other', expiry_date TEXT DEFAULT '', notes TEXT DEFAULT '', file_name TEXT DEFAULT '', file_data TEXT DEFAULT '', file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS company_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT DEFAULT 'other', description TEXT DEFAULT '', file_name TEXT DEFAULT '', file_data TEXT DEFAULT '', file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0, uploaded_by TEXT NOT NULL, uploaded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  // Quotes migration for existing deployments
  try { db.run(`CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, quote_number TEXT DEFAULT '', rep_id INTEGER NOT NULL, rep_name TEXT NOT NULL, client_name TEXT DEFAULT '', contact_name TEXT DEFAULT '', address TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '', project_name TEXT DEFAULT '', scope_summary TEXT DEFAULT '', scopes TEXT DEFAULT '[]', options TEXT DEFAULT '[]', notes TEXT DEFAULT '', subtotal TEXT DEFAULT '', tax TEXT DEFAULT '', total TEXT DEFAULT '', valid_for TEXT DEFAULT '30 days', status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  // Projects migration
  try { db.run(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number TEXT DEFAULT '',
    project_name TEXT NOT NULL,
    customer_id INTEGER DEFAULT 0,
    customer_name TEXT DEFAULT '',
    site_id INTEGER DEFAULT 0,
    location TEXT DEFAULT '',
    quote_id INTEGER DEFAULT 0,
    quote_number TEXT DEFAULT '',
    contract_value TEXT DEFAULT '',
    billing_type TEXT DEFAULT 'aftermarket',
    scope_brief TEXT DEFAULT '',
    status TEXT DEFAULT 'awarded',
    start_date TEXT DEFAULT '',
    target_end_date TEXT DEFAULT '',
    actual_end_date TEXT DEFAULT '',
    foreman_id INTEGER DEFAULT 0,
    foreman_name TEXT DEFAULT '',
    assigned_techs TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    created_by INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS project_phases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    phase_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS project_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    phase_id INTEGER DEFAULT 0,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    work_date TEXT NOT NULL,
    hours REAL NOT NULL DEFAULT 0,
    entry_type TEXT DEFAULT 'manual',
    timeclock_id INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    logged_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS project_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS project_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    po_number TEXT DEFAULT '',
    category TEXT NOT NULL DEFAULT 'materials',
    vendor TEXT DEFAULT '',
    description TEXT NOT NULL,
    quantity REAL DEFAULT 1,
    unit_cost REAL DEFAULT 0,
    total_cost REAL DEFAULT 0,
    invoice_number TEXT DEFAULT '',
    invoice_date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    logged_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS po_sequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_key TEXT UNIQUE NOT NULL,
    last_seq INTEGER DEFAULT 0
  )`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN budget_materials REAL DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN budget_equipment REAL DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN budget_labor REAL DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN budget_subs REAL DEFAULT 0`); saveDb(); } catch(e){}
  // Phase 1A.1 — link quote to customer record
  try { db.run(`ALTER TABLE quotes ADD COLUMN customer_id INTEGER DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN job_type TEXT DEFAULT 'project'`); saveDb(); } catch(e){}

  // Phase 1A.2b — site linkage on quotes (for Kroger #56 style quotes)
  try { db.run(`ALTER TABLE quotes ADD COLUMN site_id INTEGER DEFAULT 0`); saveDb(); } catch(e){}

  // Phase 1.6 — Notifications system
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    source_type TEXT DEFAULT '',
    source_id INTEGER DEFAULT 0,
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    action_url TEXT DEFAULT '',
    priority TEXT DEFAULT 'normal',
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    read_at TEXT DEFAULT '',
    cleared_at TEXT DEFAULT '',
    snoozed_until TEXT DEFAULT ''
  )`);
  saveDb();
  // Index for fast unread lookups per user
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, cleared_at)`); saveDb(); } catch(e){}
  // Track which followup notifications have already fired for each (quote, milestone) pair so we don't spam
  db.run(`CREATE TABLE IF NOT EXISTS followup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL,
    milestone_days INTEGER NOT NULL,
    fired_at TEXT DEFAULT (datetime('now')),
    UNIQUE(quote_id, milestone_days)
  )`);
  saveDb();

  // Phase 1A.5 — Workflow tasks on projects (admin task kanban like MS Planner)
  // Template tables (library of sections + tasks copied onto each new project)
  db.run(`CREATE TABLE IF NOT EXISTS workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Default Project Workflow',
    description TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();
  db.run(`CREATE TABLE IF NOT EXISTS workflow_template_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    task_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    default_role TEXT DEFAULT '',
    default_days_after_start INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  )`);
  saveDb();
  // Per-project task instances (cloned from template on project creation)
  db.run(`CREATE TABLE IF NOT EXISTS project_workflow_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    task_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    assigned_user_id INTEGER DEFAULT 0,
    assigned_user_name TEXT DEFAULT '',
    default_role TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    due_date TEXT DEFAULT '',
    completed_date TEXT DEFAULT '',
    completed_by_user_id INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    is_test_data INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();

  // Workflow role on users (so office_manager / project_manager / foreman roles can be resolved)
  try { db.run(`ALTER TABLE users ADD COLUMN workflow_roles TEXT DEFAULT '[]'`); saveDb(); } catch(e){}

  // Phase 1A.2a — Quick Job / Project fork
  // material_status: 'from_stock' | 'ordered' | 'partial' | 'received'
  try { db.run(`ALTER TABLE projects ADD COLUMN material_status TEXT DEFAULT 'ordered'`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN material_notes TEXT DEFAULT ''`); saveDb(); } catch(e){}
  // Phase 1A.5 fix — material lead time + expected date
  try { db.run(`ALTER TABLE projects ADD COLUMN material_lead_time TEXT DEFAULT ''`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN material_expected_date TEXT DEFAULT ''`); saveDb(); } catch(e){}

  // Phase 1A.5.1 — material order date (when materials were actually ordered, vs. when project was created)
  try { db.run(`ALTER TABLE projects ADD COLUMN material_order_date TEXT DEFAULT ''`); saveDb(); } catch(e){}

  // Phase 1A.4a — Billing module schema
  // bill_vendors: vendor list mirrored from QuickBooks (CSV import on day 1)
  db.run(`CREATE TABLE IF NOT EXISTS bill_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    contact_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    account_number TEXT DEFAULT '',
    terms TEXT DEFAULT '',
    default_gl_account TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    last_used_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_bill_vendors_name ON bill_vendors(name)`); saveDb(); } catch(e){}
  // Track billed-to-customer state per cost line
  try { db.run(`ALTER TABLE project_costs ADD COLUMN billed_to_customer INTEGER DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE project_costs ADD COLUMN billed_on TEXT DEFAULT ''`); saveDb(); } catch(e){}
  // Project-level billing tracking
  try { db.run(`ALTER TABLE projects ADD COLUMN billing_model TEXT DEFAULT ''`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN total_billed_to_date REAL DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN last_customer_invoice_date TEXT DEFAULT ''`); saveDb(); } catch(e){}

  // Phase 1A.6 — Equipment PO Generator schema
  db.run(`CREATE TABLE IF NOT EXISTS equipment_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    vendor_id INTEGER DEFAULT 0,
    category TEXT DEFAULT '',
    daily_rate REAL DEFAULT 0,
    weekly_rate REAL DEFAULT 0,
    monthly_rate REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();
  db.run(`CREATE TABLE IF NOT EXISTS equipment_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    main_phone TEXT DEFAULT '',
    main_email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    account_number TEXT DEFAULT '',
    contact_name TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();
  db.run(`CREATE TABLE IF NOT EXISTS equipment_pos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    vendor_id INTEGER DEFAULT 0,
    vendor_name TEXT DEFAULT '',
    job_name TEXT DEFAULT '',
    job_address TEXT DEFAULT '',
    lead_tech_id INTEGER DEFAULT 0,
    lead_tech_name TEXT DEFAULT '',
    lead_tech_phone TEXT DEFAULT '',
    sales_rep_id INTEGER DEFAULT 0,
    sales_rep_name TEXT DEFAULT '',
    sales_rep_phone TEXT DEFAULT '',
    sales_rep_email TEXT DEFAULT '',
    delivery_date TEXT DEFAULT '',
    delivery_time_window TEXT DEFAULT '',
    return_date TEXT DEFAULT '',
    delivery_notes TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    confirmation_number TEXT DEFAULT '',
    total_estimated_cost REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    cost_id INTEGER DEFAULT 0,
    created_by INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT DEFAULT '',
    email_sent_to TEXT DEFAULT '',
    is_test_data INTEGER DEFAULT 0
  )`);
  saveDb();
  db.run(`CREATE TABLE IF NOT EXISTS equipment_po_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL,
    catalog_id INTEGER DEFAULT 0,
    description TEXT NOT NULL,
    qty REAL DEFAULT 1,
    rate REAL DEFAULT 0,
    rate_period TEXT DEFAULT 'day',
    estimated_cost REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`);
  saveDb();
  // Equipment PO sequence (separate from job number sequence)
  db.run(`CREATE TABLE IF NOT EXISTS equipment_po_sequence (
    month_key TEXT PRIMARY KEY,
    last_seq INTEGER DEFAULT 0
  )`);
  saveDb();
  // bill_status: 'not_ready' | 'ready_to_bill' | 'billed' | 'paid' (simpler than a full AR state machine)
  try { db.run(`ALTER TABLE projects ADD COLUMN bill_status TEXT DEFAULT 'not_ready'`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN bill_notes TEXT DEFAULT ''`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN invoice_number TEXT DEFAULT ''`); saveDb(); } catch(e){}

  // Phase 1A.1.1 — shared monthly job number counter
  db.run(`CREATE TABLE IF NOT EXISTS job_sequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_key TEXT UNIQUE NOT NULL,
    last_seq INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();

  // Phase 1A.1.2 — test data tagging
  ['customers','customer_sites','customer_contacts','customer_equipment',
   'quotes','projects','project_phases','project_costs','project_notes','project_hours'
  ].forEach(table => {
    try { db.run(`ALTER TABLE ${table} ADD COLUMN is_test_data INTEGER DEFAULT 0`); saveDb(); } catch(e){}
  });

  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('po_format','MMYY-###')`); saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('po_prefix','')`); saveDb(); } catch(e){}

  // ═══ PHASE 1A — FOUNDATIONS ═══════════════════════════════════════════════
  // Skills master list (18 seeded — expandable via admin UI)
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    category TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Trucks / Crews
  db.run(`CREATE TABLE IF NOT EXISTS trucks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_user_id INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    row_type TEXT DEFAULT 'truck',
    notes TEXT DEFAULT '',
    temp_start_date TEXT DEFAULT '',
    temp_end_date TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Vendors (separate from customers)
  db.run(`CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    default_gl_account TEXT DEFAULT '',
    payment_terms TEXT DEFAULT 'Net 30',
    contact_name TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    w9_on_file INTEGER DEFAULT 0,
    coi_on_file INTEGER DEFAULT 0,
    coi_expiration_date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Bills (AP header — structure only, no UI yet)
  db.run(`CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER DEFAULT 0,
    vendor_name TEXT DEFAULT '',
    invoice_number TEXT DEFAULT '',
    bill_date TEXT DEFAULT '',
    due_date TEXT DEFAULT '',
    total_amount REAL DEFAULT 0,
    project_id INTEGER DEFAULT 0,
    approval_status TEXT DEFAULT 'pending',
    approved_by_user_id INTEGER DEFAULT 0,
    approved_at TEXT DEFAULT '',
    payment_status TEXT DEFAULT 'unpaid',
    paid_date TEXT DEFAULT '',
    payment_method TEXT DEFAULT '',
    exported_to_qb INTEGER DEFAULT 0,
    exported_to_qb_at TEXT DEFAULT '',
    pdf_attachment TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_by_user_id INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Bill line items (categorized breakdown per bill)
  db.run(`CREATE TABLE IF NOT EXISTS bill_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL,
    category TEXT DEFAULT 'material',
    description TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    gl_account TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    ordered_date TEXT DEFAULT '',
    expected_ship_date TEXT DEFAULT '',
    received_date TEXT DEFAULT '',
    received_qty REAL DEFAULT 0,
    received_by_user_id INTEGER DEFAULT 0,
    packing_slip_photo TEXT DEFAULT '',
    from_shop_stock INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Chart of Accounts (populated from QB CoA upload)
  db.run(`CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number TEXT DEFAULT '',
    account_name TEXT NOT NULL,
    account_type TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb();

  // New columns on users — wrap each in try/catch so safe to re-run
  try { db.run(`ALTER TABLE users ADD COLUMN skills TEXT DEFAULT '[]'`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE users ADD COLUMN labor_rate_burdened REAL DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE users ADD COLUMN labor_rate_updated_at TEXT DEFAULT ''`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE users ADD COLUMN labor_rate_updated_by_user_id INTEGER DEFAULT 0`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE users ADD COLUMN sales_department TEXT DEFAULT ''`); saveDb(); } catch(e){}

  // New columns on projects
  try { db.run(`ALTER TABLE projects ADD COLUMN work_types TEXT DEFAULT '[]'`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN required_skills TEXT DEFAULT '[]'`); saveDb(); } catch(e){}
  try { db.run(`ALTER TABLE projects ADD COLUMN revenue_department TEXT DEFAULT ''`); saveDb(); } catch(e){}

  // Seed skills (only if table is empty)
  const skillCount = get('SELECT COUNT(*) as c FROM skills');
  if (!skillCount || skillCount.c === 0) {
    const SEED_SKILLS = [
      // Doors — Sectional & Coiling
      ['sectional_standard',      'Sectional Doors',              'doors_sectional_coiling',  10],
      ['sectional_xl',            'XL Sectional Doors',           'doors_sectional_coiling',  20],
      ['coiling_standard',        'Coiling Doors',                'doors_sectional_coiling',  30],
      ['coiling_xl',              'XL Coiling Doors',             'doors_sectional_coiling',  40],
      ['fire_doors',              'Fire Doors',                   'doors_sectional_coiling',  50],
      ['high_security',           'High Security / Detention Doors','doors_sectional_coiling',60],
      // Doors — High Speed & Specialty
      ['high_speed',              'High Speed Doors',             'doors_high_speed_specialty', 10],
      ['specialty_doors',         'Specialty Doors',              'doors_high_speed_specialty', 20],
      ['renlita',                 'Renlita',                      'doors_high_speed_specialty', 30],
      ['air_curtains',            'Air Curtains',                 'doors_high_speed_specialty', 40],
      // Dock Equipment
      ['dock_levelers',           'Dock Levelers',                'dock_equipment',  10],
      ['dock_shelters',           'Dock Shelters',                'dock_equipment',  20],
      ['truck_restraints',        'Truck Restraints',             'dock_equipment',  30],
      ['misc_dock_equipment',     'Miscellaneous Dock Equipment', 'dock_equipment',  40],
      // Auto / Entry
      ['automatic_doors',         'Automatic Doors',              'auto_entry',      10],
      ['hollow_metal_hardware',   'Hollow Metal / Hardware',      'auto_entry',      20],
      // Operator / Electrical
      ['commercial_operators',    'Commercial Operators',         'operator_electrical', 10],
      ['electrical_low_voltage',  'Electrical / Low Voltage',     'operator_electrical', 20],
      // Specialty Structures
      ['mobile_modular_buildings','Mobile / Modular Buildings',   'specialty_structures', 10],
    ];
    SEED_SKILLS.forEach(s => {
      try { db.run(`INSERT INTO skills (skill_key,label,category,sort_order,active) VALUES (?,?,?,?,1)`, s); } catch(e){}
    });
    saveDb();
    console.log('  ✓ Phase 1A: Seeded ' + SEED_SKILLS.length + ' skills');
  }

  // Phase 1A.5 — Seed default workflow template on first run
  const wfTemplateCount = get('SELECT COUNT(*) AS c FROM workflow_templates');
  if (!wfTemplateCount || wfTemplateCount.c === 0) {
    const tplId = runGetId(`INSERT INTO workflow_templates (name, description, is_default, is_active)
      VALUES ('Default Project Workflow','Administrative task workflow for typical door install project. Edit or duplicate in Settings.',1,1)`);
    // Default tasks — based on user's existing Microsoft Planner board + door-industry standards
    const SEED_WF_TASKS = [
      // section, task_name, description, default_role, default_days_after_start, sort_order
      // ─── FRONT END / GENERAL CONDITIONS ─────────────────────────
      ['Front End / General Conditions', 'KVM Safety Manual',              'Submit or confirm receipt of KVM safety manual to GC', 'office_manager', 0, 10],
      ['Front End / General Conditions', 'Submit Insurance Documents',     'Send current COI to GC / property owner', 'office_manager', 0, 20],
      ['Front End / General Conditions', 'Permit / License Check',         'Verify any permits or jurisdictional licensing needed', 'project_manager', 2, 30],
      ['Front End / General Conditions', 'Kickoff Meeting',                'Internal kickoff: foreman, PM, sales rep align on scope', 'project_manager', 3, 40],
      // ─── MOBILIZE ON SITE ───────────────────────────────────────
      ['Mobilize on site', 'Field Measure Confirmed',      'Lead tech confirms measurements match shop drawings', 'foreman', 7, 10],
      ['Mobilize on site', 'Opening Built & Ready',        'Confirm GC has opening prepped for install', 'project_manager', 10, 20],
      ['Mobilize on site', 'Site Access Confirmed',        'Confirm hours, lock box, site contact, parking', 'foreman', 5, 30],
      ['Mobilize on site', 'Start Installation',           'Installation kicks off on site', 'foreman', 14, 40],
      // ─── ELECTRICAL ─────────────────────────────────────────────
      ['Electrical', 'Low Voltage Wiring Run',              'Low-voltage conduit/wire runs for operators, sensors', 'foreman', 0, 10],
      ['Electrical', 'Power Supplied to Equipment',         'Confirm GC has 120V/240V power at openings', 'project_manager', 0, 20],
      ['Electrical', 'Install & Terminate Electrical Devices', 'Terminate operators, safety edges, photo eyes, controls', 'foreman', 0, 30],
      // ─── PUNCHLIST ──────────────────────────────────────────────
      ['Punchlist', 'Punchlist Items Scheduled',            'Any deficiencies scheduled for return visit', 'project_manager', 0, 10],
      ['Punchlist', 'Contractor Punchlist Received',        'Formal punchlist received from GC', 'project_manager', 0, 20],
      ['Punchlist', 'Punchlist Completed',                  'All items resolved, customer signed off', 'foreman', 0, 30],
      // ─── CLOSING DOCUMENTS ──────────────────────────────────────
      ['Closing Documents', 'KVM Labor Warranty',           'Deliver KVM labor warranty letter', 'sales_rep', 0, 10],
      ['Closing Documents', 'Product Warranty Delivered',   'Manufacturer product warranties collected and sent to customer', 'sales_rep', 0, 20],
      ['Closing Documents', 'O&M Manuals',                  'Operation & Maintenance manuals delivered', 'project_manager', 0, 30],
      ['Closing Documents', 'Closeout Package Delivered',   'Final closeout package (warranty, O&M, pictures, invoice) sent to GC/owner', 'sales_rep', 0, 40],
      // ─── SCHEDULE ───────────────────────────────────────────────
      ['Schedule', 'Anticipated Duration Confirmed',        'Confirm schedule matches contract expectation', 'project_manager', 3, 10],
      ['Schedule', 'Week of Final Scheduling',              'Schedule final install week once materials arrive', 'project_manager', 0, 20],
      ['Schedule', 'KVM Look-Ahead Schedule Sent',          'Send 2-week look-ahead to GC', 'project_manager', 0, 30],
      ['Schedule', 'Contractor Anticipated Schedule Confirmed','Confirm GC schedule vs. our schedule', 'project_manager', 0, 40],
      // ─── PICTURES ───────────────────────────────────────────────
      ['Pictures', 'Completion Pictures',                   'Final-install photos of each opening', 'foreman', 0, 10],
      ['Pictures', 'Site Access Pictures',                  'Photos of staging/delivery access for future reference', 'foreman', 0, 20],
      ['Pictures', 'Opening Pictures',                      'Pre-install photos of openings', 'foreman', 0, 30],
      // ─── EQUIPMENT ──────────────────────────────────────────────
      ['Equipment', 'Equipment Quoted',                     'Rental equipment quoted (lift, forklift, etc.)', 'project_manager', 0, 10],
      ['Equipment', 'Order Equipment',                      'Place equipment rental PO', 'project_manager', 7, 20],
      ['Equipment', 'Equipment Provider Confirmed',         'Confirmation from rental vendor with delivery date', 'project_manager', 0, 30],
    ];
    SEED_WF_TASKS.forEach(t => {
      try {
        db.run(`INSERT INTO workflow_template_tasks
          (template_id, section, task_name, description, default_role, default_days_after_start, sort_order, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [tplId, t[0], t[1], t[2], t[3], t[4], t[5]]);
      } catch(e){}
    });
    saveDb();
    console.log('  ✓ Phase 1A.5: Seeded Default Workflow Template with ' + SEED_WF_TASKS.length + ' tasks across 8 sections');
  }

  // Default GL account map for bill categories (editable later via settings)
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_material','')`); saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_freight','')`);  saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_tax','')`);      saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_equipment','')`);saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_subs','')`);     saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_travel','')`);   saveDb(); } catch(e){}
  try { db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('gl_default_other','')`);    saveDb(); } catch(e){}
  // ═══ END PHASE 1A SCHEMA ══════════════════════════════════════════════════

  const userCount = get('SELECT COUNT(*) as c FROM users');
  if (!userCount || userCount.c === 0) seedDatabase();
}

function seedDatabase() {
  const adminHash = bcrypt.hashSync('admin123', 10);
  const pass = bcrypt.hashSync('pass123', 10);
  db.run(`INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,pto_total,pto_left,avatar_color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['admin',adminHash,'Admin','User','Office Administrator','Management','','','','admin@kvmdoors.com',1,15,15,'#7a5010']);
  const employees = [
    ['mark.todd',pass,'Mark','Todd','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0101',10,10,'#2980b9'],
    ['mjr',pass,'MJR','','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0102',10,10,'#8e44ad'],
    ['kevin',pass,'Kevin','','Overhead Door Leader','Overhead Door','Both Divisions','Leader','(313) 555-0103',10,10,'#16a085'],
    ['mike.l',pass,'Mike','L','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0104',10,10,'#b8860b'],
    ['skyler',pass,'Skyler','','Overhead Door Leader','Overhead Door','Both Divisions','Leader','(313) 555-0105',10,10,'#1a6e3a'],
    ['rob.s',pass,'Rob','S','Automatic Door Technician','Automatic Door','Automatic Door Division','Leader','(313) 555-0106',10,10,'#7a5010'],
    ['steve.winter',pass,'Steve','Winter Sr.','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0107',10,10,'#5d4e8a'],
    ['k.shaw',pass,'K','Shaw','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0108',10,10,'#2980b9'],
    ['m5',pass,'M5','','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0109',10,10,'#8e44ad'],
    ['scott.evans',pass,'Scott','Evans','Automatic Door Technician','Automatic Door','Automatic Door Division','Leader','(313) 555-0110',10,10,'#16a085'],
    ['emmet',pass,'Emmet','','Overhead Door Helper','Overhead Door','Overhead Door Division','Helper','(313) 555-0111',10,10,'#b8860b'],
    ['anthony',pass,'Anthony','','Overhead Door Helper','Overhead Door','Overhead Door Division','Helper','(313) 555-0112',10,10,'#1a6e3a'],
    ['sherman',pass,'Sherman','','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0113',10,10,'#7a5010'],
    ['robert.jr',pass,'Robert','Jr','Overhead Door Helper','Overhead Door','Overhead Door Division','Helper','(313) 555-0114',10,10,'#5d4e8a'],
    ['sean.mccann',pass,'Sean','McCann','Overhead Door Helper','Overhead Door','Overhead Door Division','Helper','(313) 555-0115',10,10,'#2980b9'],
    ['derek',pass,'Derek','','Overhead Door Helper','Overhead Door','Overhead Door Division','Helper','(313) 555-0116',10,10,'#8e44ad'],
    ['jermiah',pass,'Jermiah','','Overhead Door Helper','Overhead Door','Overhead Door Division','Helper','(313) 555-0117',10,10,'#16a085'],
    ['k.berry',pass,'K','Berry','Automatic Door Technician','Automatic Door','Automatic Door Division','Leader','(313) 555-0118',10,10,'#b8860b'],
    ['lorne',pass,'Lorne','','Overhead Door Leader','Overhead Door','Overhead Door Division','Leader','(313) 555-0119',10,10,'#5d4e8a'],
  ];
  employees.forEach(e => {
    db.run(`INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,pto_total,pto_left,avatar_color) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [e[0],e[1],e[2],e[3],e[4],e[5],e[6],e[7],e[8],'',e[9],e[10],e[11]]);
  });
  const mikeL = get('SELECT id FROM users WHERE username=?',['mike.l']);
  const robertJr = get('SELECT id FROM users WHERE username=?',['robert.jr']);
  if (mikeL && robertJr) {
    db.run('UPDATE users SET paired_with=? WHERE id=?',[robertJr.id,mikeL.id]);
    db.run('UPDATE users SET paired_with=? WHERE id=?',[mikeL.id,robertJr.id]);
  }
  const ohOrder = ['mark.todd','mjr','kevin','mike.l','skyler','steve.winter','k.shaw','m5','sherman','emmet','anthony','robert.jr','sean.mccann','derek','jermiah'];
  ohOrder.forEach((uname,idx) => {
    const u = get('SELECT id FROM users WHERE username=?',[uname]);
    if (u) db.run(`INSERT INTO oncall_rotation (department,user_id,position) VALUES (?,?,?)`,['Overhead Door Division',u.id,idx+1]);
  });
  ['rob.s','kevin','skyler','scott.evans'].forEach((uname,idx) => {
    const u = get('SELECT id FROM users WHERE username=?',[uname]);
    if (u) db.run(`INSERT INTO oncall_rotation (department,user_id,position) VALUES (?,?,?)`,['Automatic Door Division',u.id,idx+1]);
  });
  db.run(`INSERT INTO announcements (title,body,priority,author_name) VALUES (?,?,?,?)`,['Welcome to the KVM Employee Portal','Your new portal is live! Check on-call schedules, request PTO, and read company news all in one place.','info','Admin']);
  db.run(`INSERT INTO announcements (title,body,priority,author_name) VALUES (?,?,?,?)`,['Safety Reminder','All field crews must wear full PPE on every job site. Zero exceptions.','urgent','Admin']);
  db.run(`INSERT INTO news (title,body,category,author_name) VALUES (?,?,?,?)`,['KVM Completes 500th Door Installation','Our team hit a major milestone this month. Great work to the whole crew!','Recognition','Admin']);
  db.run(`INSERT INTO news (title,body,category,author_name) VALUES (?,?,?,?)`,['Q2 Safety Record: Zero Incidents','Perfect safety record for Q2. Keep up the excellent awareness on every job site.','Safety','Admin']);
  db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`,['smtp_host','smtp.office365.com']);
  db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`,['smtp_port','587']);
  db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`,['smtp_from_name','KVM Door Systems']);
  saveDb();
  console.log('  ✓ Database seeded with KVM employees');
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ═══ CACHE-BUST PATCH ═══════════════════════════════════════════════════════
// APP_VERSION is generated once at server boot and included in HTML and sw.js
// so every redeploy automatically invalidates browser caches without manual work.
const APP_VERSION = (() => {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
})();
console.log('[KVM] APP_VERSION:', APP_VERSION);

// Expose version to clients (so app.js can poll for updates without reloading)
app.get('/api/app-version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION });
});

// Serve index.html with version stamps injected. Replaces tokens like __APP_VERSION__
// in <script src="/js/app.js?v=__APP_VERSION__"> and similar.
app.get('/', (req, res, next) => {
  try {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(htmlPath)) return next();
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/__APP_VERSION__/g, APP_VERSION);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { next(e); }
});

// Serve sw.js with version stamped in (so the worker file content changes per deploy,
// which is what triggers the browser to install the new worker)
app.get('/sw.js', (req, res, next) => {
  try {
    const swPath = path.join(__dirname, 'public', 'sw.js');
    if (!fs.existsSync(swPath)) return next();
    let js = fs.readFileSync(swPath, 'utf8');
    js = js.replace(/__APP_VERSION__/g, APP_VERSION);
    // Service worker should not be cached by HTTP layer (browser caches it differently)
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.send(js);
  } catch (e) { next(e); }
});
// ═══ END CACHE-BUST PATCH ═══════════════════════════════════════════════════

app.use(express.static(path.join(__dirname,'public')));
app.use(cors({origin:['http://kvmdoor.com','https://kvmdoor.com','http://www.kvmdoor.com','https://www.kvmdoor.com'],credentials:true}));
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR,{recursive:true});
const sessionConfig = {
  secret: 'kvm-door-v3-2024', resave: false, saveUninitialized: false, rolling: true,
  cookie: { maxAge: 24*60*60*1000 }
};
if (FileStore) {
  sessionConfig.store = new FileStore({ path: SESSION_DIR, ttl: 86400, retries: 0, logFn: ()=>{} });
  console.log('Using file-based session store');
} else {
  console.log('session-file-store not available, using memory store');
}
app.use(session(sessionConfig));

// ─── ROLE CONSTANTS ───────────────────────────────────────────────────────────
const ADMIN_ROLES   = ['global_admin','admin'];
const MANAGER_ROLES = ['global_admin','admin','manager'];
const FIELD_ROLES   = ['global_admin','admin','manager','billing','sales','dispatcher'];

function getUserRole(userId) {
  const u = get('SELECT role_type FROM users WHERE id=?',[userId]);
  return u ? (u.role_type || 'technician') : null;
}
const requireAuth = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Not authenticated'});
  next();
};
const requireAdmin = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Not authenticated'});
  const role = getUserRole(req.session.userId);
  if (!role || !ADMIN_ROLES.includes(role)) return res.status(403).json({error:'Admin access required'});
  next();
};
const requireManager = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Not authenticated'});
  const role = getUserRole(req.session.userId);
  if (!role || !MANAGER_ROLES.includes(role)) return res.status(403).json({error:'Manager access required'});
  next();
};

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body;
  const user=get('SELECT * FROM users WHERE username=?',[username]);
  if(!user||!bcrypt.compareSync(password,user.password)) return res.status(401).json({error:'Invalid username or password'});
  req.session.userId = user.id;
  let loginRole = user.role_type || '';
  if (!loginRole) {
    loginRole = user.is_admin ? 'global_admin' : 'technician';
    run("UPDATE users SET role_type=? WHERE id=?",[loginRole,user.id]);
  }
  res.json({id:user.id,username:user.username,first_name:user.first_name,last_name:user.last_name,role:user.role,department:user.department,role_type:loginRole,avatar_color:user.avatar_color});
});
app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});
app.get('/api/me',requireAuth,(req,res)=>{
  const u=get('SELECT id,username,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date FROM users WHERE id=?',[req.session.userId]);
  if(!u) return res.status(404).json({error:'Not found'});
  let role_type = u.role_type || '';
  if (!role_type) {
    role_type = u.is_admin ? 'global_admin' : 'technician';
    run("UPDATE users SET role_type=? WHERE id=?",[role_type,u.id]);
  }
  res.json({...u,role_type,is_admin:!!u.is_admin});
});

// ─── USERS ────────────────────────────────────────────────────────────────────
app.get('/api/users',requireAuth,(req,res)=>{
  res.json(all('SELECT id,username,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date,sales_department FROM users ORDER BY first_name').map(u=>({...u,is_admin:!!u.is_admin})));
});
app.post('/api/users',requireAdmin,(req,res)=>{
  const {username,password,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date}=req.body;
  if(!username||!password||!first_name) return res.status(400).json({error:'Missing required fields'});
  if(get('SELECT id FROM users WHERE username=?',[username])) return res.status(400).json({error:'Username already exists'});
  const id=runGetId(`INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username,bcrypt.hashSync(password,10),first_name,last_name||'',role||'',department||'',oncall_dept||'',oncall_role||'',paired_with||0,phone||'',email||'',is_admin?1:0,role_type||'technician',pto_total||10,pto_left||10,avatar_color||'#7a5010',hire_date||'']);
  res.json({id});
});
app.put('/api/users/:id',requireManager,(req,res)=>{
  const callerRole = getUserRole(req.session.userId);
  const isAdmin = ADMIN_ROLES.includes(callerRole||'');
  if (isAdmin) {
    const {first_name,last_name,username,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,pto_total,pto_left,hire_date,role_type}=req.body;
    if(!first_name||!username) return res.status(400).json({error:'First name and username are required'});
    const existing=get('SELECT id FROM users WHERE username=? AND id!=?',[username,req.params.id]);
    if(existing) return res.status(400).json({error:'Username already taken'});
    const newIsAdmin=['global_admin','admin'].includes(role_type||'')?1:0;
    run(`UPDATE users SET first_name=?,last_name=?,username=?,role=?,department=?,oncall_dept=?,oncall_role=?,paired_with=?,phone=?,email=?,is_admin=?,role_type=?,pto_total=?,pto_left=?,hire_date=? WHERE id=?`,
      [first_name,last_name||'',username,role||'',department||'',oncall_dept||'',oncall_role||'',paired_with||0,phone||'',email||'',newIsAdmin,role_type||'technician',pto_total||10,pto_left||10,hire_date||'',req.params.id]);
  } else {
    const {first_name,last_name,role,department,oncall_dept,oncall_role,phone,email}=req.body;
    if(!first_name) return res.status(400).json({error:'First name is required'});
    const target=get('SELECT role_type FROM users WHERE id=?',[req.params.id]);
    if(target&&MANAGER_ROLES.includes(target.role_type||'')) return res.status(403).json({error:'Managers cannot edit other managers or admin accounts'});
    run(`UPDATE users SET first_name=?,last_name=?,role=?,department=?,oncall_dept=?,oncall_role=?,phone=?,email=? WHERE id=?`,
      [first_name,last_name||'',role||'',department||'',oncall_dept||'',oncall_role||'',phone||'',email||'',req.params.id]);
  }
  res.json({ok:true});
});
app.put('/api/users/me/password',requireAuth,(req,res)=>{
  const {current_password,new_password}=req.body;
  if(!current_password||!new_password) return res.status(400).json({error:'Missing fields'});
  if(new_password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const user=get('SELECT * FROM users WHERE id=?',[req.session.userId]);
  if(!user||!bcrypt.compareSync(current_password,user.password)) return res.status(401).json({error:'Current password is incorrect'});
  run('UPDATE users SET password=? WHERE id=?',[bcrypt.hashSync(new_password,10),req.session.userId]);
  res.json({ok:true});
});
app.put('/api/users/:id/password',requireAdmin,(req,res)=>{
  const {new_password}=req.body;
  if(!new_password||new_password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const user=get('SELECT id FROM users WHERE id=?',[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  run('UPDATE users SET password=? WHERE id=?',[bcrypt.hashSync(new_password,10),req.params.id]);
  res.json({ok:true});
});
app.delete('/api/users/:id',requireAdmin,(req,res)=>{
  if(parseInt(req.params.id)===1) return res.status(403).json({error:'Cannot delete primary admin'});
  run('DELETE FROM users WHERE id=?',[req.params.id]);res.json({ok:true});
});

// ─── ROTATION ─────────────────────────────────────────────────────────────────
app.get('/api/rotation',requireAdmin,(req,res)=>{
  const oh=all(`SELECT r.position,u.id,u.first_name,u.last_name,u.oncall_role,u.phone,u.paired_with FROM oncall_rotation r JOIN users u ON r.user_id=u.id WHERE r.department='Overhead Door Division' ORDER BY r.position`);
  const au=all(`SELECT r.position,u.id,u.first_name,u.last_name,u.oncall_role,u.phone FROM oncall_rotation r JOIN users u ON r.user_id=u.id WHERE r.department='Automatic Door Division' ORDER BY r.position`);
  res.json({overhead:oh,automatic:au});
});
app.put('/api/rotation',requireAdmin,(req,res)=>{
  const {department,order}=req.body;
  run('DELETE FROM oncall_rotation WHERE department=?',[department]);
  order.forEach((uid,idx)=>db.run('INSERT INTO oncall_rotation (department,user_id,position) VALUES (?,?,?)',[department,uid,idx+1]));
  saveDb();res.json({ok:true});
});

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
app.get('/api/announcements',requireAuth,(req,res)=>res.json(all('SELECT * FROM announcements ORDER BY created_at DESC')));
app.post('/api/announcements',requireAdmin,(req,res)=>{
  const {title,body,priority}=req.body;if(!title||!body) return res.status(400).json({error:'Missing fields'});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  res.json({id:runGetId('INSERT INTO announcements (title,body,priority,author_name,created_at) VALUES (?,?,?,?,?)',[title,body,priority||'normal',u.first_name+' '+u.last_name,nowStr()])});
});
app.delete('/api/announcements/:id',requireAdmin,(req,res)=>{run('DELETE FROM announcements WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── NEWS ─────────────────────────────────────────────────────────────────────
app.get('/api/news',requireAuth,(req,res)=>res.json(all('SELECT * FROM news ORDER BY created_at DESC')));
app.post('/api/news',requireAdmin,(req,res)=>{
  const {title,body,category}=req.body;if(!title||!body) return res.status(400).json({error:'Missing fields'});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  res.json({id:runGetId('INSERT INTO news (title,body,category,author_name,created_at) VALUES (?,?,?,?,?)',[title,body,category||'General',u.first_name+' '+u.last_name,nowStr()])});
});
app.delete('/api/news/:id',requireAdmin,(req,res)=>{run('DELETE FROM news WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── ON-CALL ─────────────────────────────────────────────────────────────────
app.get('/api/oncall',requireAuth,(req,res)=>res.json(all('SELECT * FROM oncall ORDER BY start_date')));
app.post('/api/oncall',requireAdmin,(req,res)=>{
  const {name,role,phone,department,start_date,end_date}=req.body;
  if(!name||!phone||!start_date||!end_date) return res.status(400).json({error:'Missing fields'});
  res.json({id:runGetId('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[name,role||'',phone,department||'',start_date,end_date])});
});
app.delete('/api/oncall/:id',requireAdmin,(req,res)=>{run('DELETE FROM oncall WHERE id=?',[req.params.id]);res.json({ok:true});});
app.put('/api/oncall/:id/swap',requireAdmin,(req,res)=>{
  const {user_id}=req.body;if(!user_id) return res.status(400).json({error:'Missing user_id'});
  const user=get('SELECT first_name,last_name,role,phone FROM users WHERE id=?',[user_id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const name=user.first_name+(user.last_name?' '+user.last_name:'');
  run('UPDATE oncall SET name=?,role=?,phone=? WHERE id=?',[name,user.role||'',user.phone||'',req.params.id]);
  res.json({ok:true});
});

// ─── BLACKOUTS ────────────────────────────────────────────────────────────────
app.get('/api/blackouts',requireAuth,(req,res)=>res.json(all('SELECT * FROM blackouts ORDER BY start_date')));
app.post('/api/blackouts',requireAdmin,(req,res)=>{
  const {label,start_date,end_date}=req.body;if(!label||!start_date||!end_date) return res.status(400).json({error:'Missing fields'});
  res.json({id:runGetId('INSERT INTO blackouts (label,start_date,end_date) VALUES (?,?,?)',[label,start_date,end_date])});
});
app.delete('/api/blackouts/:id',requireAdmin,(req,res)=>{run('DELETE FROM blackouts WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── PTO ─────────────────────────────────────────────────────────────────────
app.get('/api/pto/all-approved',requireAuth,(req,res)=>{res.json(all("SELECT * FROM pto_requests WHERE status='approved' ORDER BY start_date"));});
app.get('/api/attendance/my-callins',requireAuth,(req,res)=>{
  const callins=all('SELECT * FROM callins WHERE user_id=? ORDER BY call_in_date DESC',[req.session.userId]);
  const tardies=all("SELECT * FROM attendance WHERE user_id=? AND event_type='tardy' ORDER BY event_date DESC",[req.session.userId]);
  res.json({callins,tardies,total_callins:callins.length,total_tardies:tardies.length});
});
app.get('/api/pto',requireAuth,(req,res)=>{
  res.json(req.session.isAdmin?all('SELECT * FROM pto_requests ORDER BY submitted_at DESC'):all('SELECT * FROM pto_requests WHERE user_id=? ORDER BY submitted_at DESC',[req.session.userId]));
});
app.post('/api/pto',requireAuth,(req,res)=>{
  const {start_date,end_date,type,notes,days}=req.body;
  if(!start_date||!end_date||!days) return res.status(400).json({error:'Missing fields'});
  const conflict=all('SELECT * FROM blackouts').find(b=>start_date<=b.end_date&&end_date>=b.start_date);
  if(conflict) return res.status(400).json({error:`Dates overlap blackout: "${conflict.label}"`});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const id=runGetId('INSERT INTO pto_requests (user_id,user_name,start_date,end_date,type,notes,days,submitted_at) VALUES (?,?,?,?,?,?,?,?)',
    [req.session.userId,u.first_name+' '+u.last_name,start_date,end_date,type||'Vacation',notes||'',days,nowStr()]);
  // Phase 1.6 — notify all admins/managers
  try { notifyPTORequestPending(id); } catch(e){}
  res.json({id});
});
app.put('/api/pto/:id/review',requireAdmin,async(req,res)=>{
  const {status}=req.body;
  if(!['approved','denied'].includes(status)) return res.status(400).json({error:'Invalid status'});
  const r=get('SELECT * FROM pto_requests WHERE id=?',[req.params.id]);
  if(!r) return res.status(404).json({error:'Not found'});
  run('UPDATE pto_requests SET status=?,reviewed_at=? WHERE id=?',[status,nowStr(),req.params.id]);
  if(status==='approved'){
    const u=get('SELECT pto_left FROM users WHERE id=?',[r.user_id]);
    if(u) run('UPDATE users SET pto_left=? WHERE id=?',[Math.max(0,u.pto_left-r.days),r.user_id]);
  }
  const user=get('SELECT email,first_name FROM users WHERE id=?',[r.user_id]);
  if(user&&user.email) sendPtoEmail(user.email,user.first_name,status,r);
  res.json({ok:true});
});

// ─── SETTINGS ────────────────────────────────────────────────────────────────
app.get('/api/settings',requireAdmin,(req,res)=>{const s=getSettings();delete s.smtp_pass;delete s.gcal_key;res.json(s);});
app.post('/api/settings/test-email',requireAdmin,async(req,res)=>{
  const settings=getSettings();
  if(!settings.smtp_host||!settings.smtp_user||!settings.smtp_pass) return res.status(400).json({error:'Email settings not configured.'});
  try {
    const transporter=nodemailer.createTransport({host:settings.smtp_host,port:parseInt(settings.smtp_port)||587,secure:false,auth:{user:settings.smtp_user,pass:settings.smtp_pass},tls:{rejectUnauthorized:false}});
    const user=get('SELECT email,first_name FROM users WHERE id=?',[req.session.userId]);
    const toEmail=user&&user.email?user.email:settings.smtp_user;
    await transporter.sendMail({from:`"${settings.smtp_from_name||'KVM Door Systems'}" <${settings.smtp_user}>`,to:toEmail,subject:'KVM Portal — Test Email',html:'<div style="font-family:Arial,sans-serif;padding:20px"><h2 style="color:#F5A623">KVM Door Systems Portal</h2><p>This is a test email confirming your email notifications are working correctly.</p></div>'});
    res.json({ok:true,sent_to:toEmail});
  } catch(e){res.status(500).json({error:'Email failed: '+e.message});}
});
app.post('/api/settings',requireAdmin,(req,res)=>{
  ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from_name','gcal_id','gcal_key'].forEach(k=>{
    if(req.body[k]!==undefined){if(get('SELECT key FROM settings WHERE key=?',[k])) run('UPDATE settings SET value=? WHERE key=?',[req.body[k],k]);else run('INSERT INTO settings (key,value) VALUES (?,?)',[k,req.body[k]]);}
  });
  res.json({ok:true});
});

app.post('/api/oncall/seed-schedule',requireAdmin,(req,res)=>{
  const today=new Date().toISOString().split('T')[0];
  run('DELETE FROM oncall WHERE start_date >= ?',[today]);
  const schedule=[
    ['2026-03-21','2026-03-27','mike.l','robert.jr','scott.evans'],
    ['2026-03-28','2026-04-03','steve.winter','jermiah','skyler'],
    ['2026-04-04','2026-04-10','sherman','emmet','k.berry'],
    ['2026-04-11','2026-04-17','lorne','derek','rob.s'],
    ['2026-04-18','2026-04-24','mjr','sean.mccann','scott.evans'],
    ['2026-04-25','2026-05-01','k.shaw','anthony','skyler'],
    ['2026-05-02','2026-05-08','mike.l','robert.jr','k.berry'],
    ['2026-05-09','2026-05-15','mark.todd','jermiah','scott.evans'],
    ['2026-05-16','2026-05-22','steve.winter','derek','rob.s'],
    ['2026-05-23','2026-05-29','sherman','emmet','skyler'],
    ['2026-05-30','2026-06-05','mjr','sean.mccann','k.berry'],
    ['2026-06-06','2026-06-12','lorne','anthony','scott.evans'],
    ['2026-06-13','2026-06-19','mike.l','robert.jr','rob.s'],
  ];
  let created=0;
  schedule.forEach(([start,end,oh1un,oh2un,adun])=>{
    const oh1=get('SELECT first_name,last_name,role,phone FROM users WHERE username=?',[oh1un]);
    const oh2=get('SELECT first_name,last_name,role,phone FROM users WHERE username=?',[oh2un]);
    const ad=get('SELECT first_name,last_name,role,phone FROM users WHERE username=?',[adun]);
    const mkName=u=>u?u.first_name+(u.last_name?' '+u.last_name:''):null;
    if(oh1){db.run('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[mkName(oh1),oh1.role||'',oh1.phone||'','Overhead Door Division',start,end]);created++;}
    if(oh2){db.run('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[mkName(oh2),oh2.role||'',oh2.phone||'','Overhead Door Division',start,end]);created++;}
    if(ad){db.run('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[mkName(ad),ad.role||'',ad.phone||'','Automatic Door Division',start,end]);created++;}
  });
  saveDb();
  res.json({ok:true,created,message:`Loaded ${schedule.length} weeks, ${created} entries`});
});

// ─── EMPLOYEE DOCUMENTS ───────────────────────────────────────────────────────
app.get('/api/docs/my',requireAuth,(req,res)=>{res.json(all('SELECT id,user_id,user_name,doc_name,doc_type,expiry_date,notes,file_name,file_type,file_size,uploaded_at FROM employee_docs WHERE user_id=? ORDER BY uploaded_at DESC',[req.session.userId]));});
app.get('/api/docs/all',requireAdmin,(req,res)=>{res.json(all('SELECT id,user_id,user_name,doc_name,doc_type,expiry_date,notes,file_name,file_type,file_size,uploaded_at FROM employee_docs ORDER BY user_name,uploaded_at DESC'));});
app.get('/api/docs/:id/download',requireAuth,(req,res)=>{
  const doc=get('SELECT * FROM employee_docs WHERE id=?',[req.params.id]);
  if(!doc) return res.status(404).json({error:'Not found'});
  const isAdmin=!!(get('SELECT is_admin FROM users WHERE id=?',[req.session.userId])||{}).is_admin;
  if(doc.user_id!==req.session.userId&&!isAdmin) return res.status(403).json({error:'Access denied'});
  const buf=Buffer.from(doc.file_data,'base64');
  res.setHeader('Content-Type',doc.file_type||'application/octet-stream');
  res.setHeader('Content-Disposition','attachment; filename="'+doc.file_name+'"');
  res.send(buf);
});
app.post('/api/docs',requireAuth,(req,res)=>{
  const {doc_name,doc_type,expiry_date,notes,file_name,file_data,file_type,file_size}=req.body;
  if(!doc_name||!file_data) return res.status(400).json({error:'Missing document name or file'});
  if(file_size>5*1024*1024) return res.status(400).json({error:'File too large (max 5MB)'});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const user_name=u.first_name+(u.last_name?' '+u.last_name:'');
  const id=runGetId('INSERT INTO employee_docs (user_id,user_name,doc_name,doc_type,expiry_date,notes,file_name,file_data,file_type,file_size) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.session.userId,user_name,doc_name,doc_type||'other',expiry_date||'',notes||'',file_name||'',file_data,file_type||'',file_size||0]);
  res.json({id});
});
app.delete('/api/docs/:id',requireAuth,(req,res)=>{
  const doc=get('SELECT user_id FROM employee_docs WHERE id=?',[req.params.id]);
  if(!doc) return res.status(404).json({error:'Not found'});
  const isAdmin=!!(get('SELECT is_admin FROM users WHERE id=?',[req.session.userId])||{}).is_admin;
  if(doc.user_id!==req.session.userId&&!isAdmin) return res.status(403).json({error:'Access denied'});
  run('DELETE FROM employee_docs WHERE id=?',[req.params.id]);res.json({ok:true});
});

// ─── COMPANY POLICIES ─────────────────────────────────────────────────────────
app.get('/api/policies',requireAuth,(req,res)=>{res.json(all('SELECT id,title,category,description,file_name,file_type,file_size,uploaded_by,uploaded_at FROM company_policies ORDER BY category,uploaded_at DESC'));});
app.get('/api/policies/:id/download',requireAuth,(req,res)=>{
  const doc=get('SELECT * FROM company_policies WHERE id=?',[req.params.id]);
  if(!doc) return res.status(404).json({error:'Not found'});
  const buf=Buffer.from(doc.file_data,'base64');
  res.setHeader('Content-Type',doc.file_type||'application/octet-stream');
  res.setHeader('Content-Disposition','attachment; filename="'+doc.file_name+'"');
  res.send(buf);
});
app.post('/api/policies',requireAdmin,(req,res)=>{
  const {title,category,description,file_name,file_data,file_type,file_size}=req.body;
  if(!title||!file_data) return res.status(400).json({error:'Missing title or file'});
  if(file_size>10*1024*1024) return res.status(400).json({error:'File too large (max 10MB)'});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const uploaded_by=u.first_name+(u.last_name?' '+u.last_name:'');
  const id=runGetId('INSERT INTO company_policies (title,category,description,file_name,file_data,file_type,file_size,uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
    [title,category||'other',description||'',file_name||'',file_data,file_type||'',file_size||0,uploaded_by]);
  res.json({id});
});
app.delete('/api/policies/:id',requireAdmin,(req,res)=>{run('DELETE FROM company_policies WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── TIMECLOCK ────────────────────────────────────────────────────────────────
const OFFICE_DEPARTMENTS=['Management','Executives','Executive','Office','Office Staff','Sales','Admin','Administration'];
const SHOP_LAT=42.55514;
const SHOP_LNG=-82.866313;
const GEOFENCE_RADIUS_M=500*0.3048;

function getWeekStart(dateStr){
  const d=new Date(dateStr+'T00:00:00');const day=d.getDay();const diff=day===0?-6:1-day;d.setDate(d.getDate()+diff);return d.toISOString().split('T')[0];
}
function calcMinutes(clockIn,clockOut){if(!clockIn||!clockOut)return 0;return Math.round((new Date(clockOut)-new Date(clockIn))/60000);}

app.get('/api/timeclock/status',requireAuth,(req,res)=>{
  const active=get('SELECT * FROM timeclock WHERE user_id=? AND status=? ORDER BY clock_in DESC LIMIT 1',[req.session.userId,'in']);
  res.json({clocked_in:!!active,entry:active||null});
});
app.post('/api/timeclock/in',requireAuth,(req,res)=>{
  const {latitude,longitude,clock_type,job_name,customer_name,notes,is_union,is_offsite}=req.body;
  const active=get('SELECT id FROM timeclock WHERE user_id=? AND status=?',[req.session.userId,'in']);
  if(active) return res.status(400).json({error:'Already clocked in. Please clock out first.'});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const user_name=u.first_name+(u.last_name?' '+u.last_name:'');
  const now=new Date().toISOString();
  const week_start=getWeekStart(now.split('T')[0]);
  const id=runGetId(`INSERT INTO timeclock (user_id,user_name,clock_type,status,clock_in,latitude_in,longitude_in,job_name,customer_name,notes,is_union,is_offsite,week_start) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.session.userId,user_name,clock_type||'shop','in',now,latitude||null,longitude||null,job_name||'',customer_name||'',notes||'',is_union?1:0,is_offsite?1:0,week_start]);
  checkTardiness(req.session.userId,user_name,now);
  res.json({id,clock_in:now});
});
app.post('/api/timeclock/out',requireAuth,(req,res)=>{
  const {latitude,longitude,notes}=req.body;
  const active=get('SELECT * FROM timeclock WHERE user_id=? AND status=?',[req.session.userId,'in']);
  if(!active) return res.status(400).json({error:'Not currently clocked in.'});
  const now=new Date().toISOString();
  const total_minutes=calcMinutes(active.clock_in,now);
  run('UPDATE timeclock SET status=?,clock_out=?,latitude_out=?,longitude_out=?,total_minutes=? WHERE id=?',
    ['out',now,latitude||null,longitude||null,total_minutes,active.id]);
  res.json({ok:true,clock_out:now,total_minutes});
});
app.post('/api/timeclock/alert',requireAuth,(req,res)=>{
  const {alert_type,latitude,longitude}=req.body;
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const user_name=u.first_name+(u.last_name?' '+u.last_name:'');
  runGetId('INSERT INTO geofence_alerts (user_id,user_name,alert_type,latitude,longitude) VALUES (?,?,?,?,?)',
    [req.session.userId,user_name,alert_type,latitude||null,longitude||null]);
  res.json({ok:true});
});
app.get('/api/timeclock/my',requireAuth,(req,res)=>{
  const {week}=req.query;
  let entries;
  if(week){
    const weekStart=new Date(week+'T00:00:00');const weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+6);
    const weekEndStr=weekEnd.toISOString().split('T')[0];
    entries=all(`SELECT * FROM timeclock WHERE user_id=? AND date(clock_in) BETWEEN ? AND ? ORDER BY clock_in DESC`,[req.session.userId,week,weekEndStr]);
  } else {
    entries=all('SELECT * FROM timeclock WHERE user_id=? ORDER BY clock_in DESC LIMIT 50',[req.session.userId]);
  }
  res.json(entries);
});
app.get('/api/timeclock/all',requireAdmin,(req,res)=>{
  const {week}=req.query;
  const thisWeek=getWeekStart(new Date().toISOString().split('T')[0]);
  const entries=all('SELECT * FROM timeclock WHERE week_start=? ORDER BY user_name,clock_in',[week||thisWeek]);
  res.json(entries);
});
app.get('/api/timeclock/summary',requireAdmin,(req,res)=>{
  const targetWeek=(req.query.week)||getWeekStart(new Date().toISOString().split('T')[0]);
  const entries=all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name,clock_in',[targetWeek,'out']);
  const summary={};
  entries.forEach(e=>{
    if(!summary[e.user_id]) summary[e.user_id]={user_name:e.user_name,total_minutes:0,entries:[],overtime_minutes:0,is_union:!!e.is_union};
    summary[e.user_id].total_minutes+=e.total_minutes||0;summary[e.user_id].entries.push(e);
  });
  Object.values(summary).forEach(u=>{
    u.overtime_minutes=Math.max(0,u.total_minutes-2400);u.regular_minutes=Math.min(u.total_minutes,2400);
    u.total_hours=(u.total_minutes/60).toFixed(2);u.overtime_hours=(u.overtime_minutes/60).toFixed(2);u.regular_hours=(u.regular_minutes/60).toFixed(2);
  });
  res.json({week:targetWeek,summary:Object.values(summary)});
});
app.get('/api/timeclock/alerts',requireAdmin,(req,res)=>{res.json(all('SELECT * FROM geofence_alerts WHERE resolved=0 ORDER BY created_at DESC'));});
app.put('/api/timeclock/alerts/:id/resolve',requireAdmin,(req,res)=>{run('UPDATE geofence_alerts SET resolved=1 WHERE id=?',[req.params.id]);res.json({ok:true});});
app.put('/api/timeclock/:id',requireAdmin,(req,res)=>{
  const {clock_in,clock_out,job_name,notes}=req.body;
  const entry=get('SELECT * FROM timeclock WHERE id=?',[req.params.id]);
  if(!entry) return res.status(404).json({error:'Not found'});
  const total_minutes=calcMinutes(clock_in||entry.clock_in,clock_out||entry.clock_out);
  const week_start=getWeekStart((clock_in||entry.clock_in).split('T')[0]);
  run('UPDATE timeclock SET clock_in=?,clock_out=?,job_name=?,notes=?,total_minutes=?,week_start=?,status=? WHERE id=?',
    [clock_in||entry.clock_in,clock_out||entry.clock_out,job_name||entry.job_name,notes||entry.notes,total_minutes,week_start,clock_out?'out':entry.status,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/timeclock/:id',requireAdmin,(req,res)=>{run('DELETE FROM timeclock WHERE id=?',[req.params.id]);res.json({ok:true});});
app.post('/api/timeclock/send-timecards',requireAdmin,async(req,res)=>{
  const {week}=req.body;const targetWeek=week||getWeekStart(new Date().toISOString().split('T')[0]);
  const settings=getSettings();
  if(!settings.smtp_host||!settings.smtp_user||!settings.smtp_pass) return res.status(400).json({error:'Email not configured in Portal Settings'});
  const entries=all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name,clock_in',[targetWeek,'out']);
  const byUser={};
  entries.forEach(e=>{if(!byUser[e.user_id]) byUser[e.user_id]={name:e.user_name,entries:[],total:0};byUser[e.user_id].entries.push(e);byUser[e.user_id].total+=e.total_minutes||0;});
  const transporter=nodemailer.createTransport({host:settings.smtp_host,port:parseInt(settings.smtp_port)||587,secure:false,auth:{user:settings.smtp_user,pass:settings.smtp_pass},tls:{rejectUnauthorized:false}});
  let sent=0;
  for(const [uid,data] of Object.entries(byUser)){
    const user=get('SELECT email FROM users WHERE id=?',[uid]);
    if(!user||!user.email) continue;
    const hrs=(data.total/60).toFixed(2);const ot=Math.max(0,data.total-2400);const otHrs=(ot/60).toFixed(2);
    const rows=data.entries.map(e=>`<tr><td style="padding:6px 10px;border-bottom:1px solid #333">${new Date(e.clock_in).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${new Date(e.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${e.clock_out?new Date(e.clock_out).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'—'}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${((e.total_minutes||0)/60).toFixed(2)} hrs</td><td style="padding:6px 10px;border-bottom:1px solid #333">${e.clock_type}${e.is_union?' (Union)':''}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${e.job_name||'—'}</td></tr>`).join('');
    const html=`<div style="font-family:Arial,sans-serif;max-width:700px"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623">Weekly Timecard — ${data.name}</h2><p>Week of: <strong>${targetWeek}</strong></p><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f0f0f0"><th style="padding:8px 10px;text-align:left">Date</th><th style="padding:8px 10px;text-align:left">In</th><th style="padding:8px 10px;text-align:left">Out</th><th style="padding:8px 10px;text-align:left">Hours</th><th style="padding:8px 10px;text-align:left">Type</th><th style="padding:8px 10px;text-align:left">Job</th></tr></thead><tbody>${rows}</tbody></table><div style="background:#f9f9f9;padding:12px;border-radius:6px;margin-top:12px"><strong>Regular Hours:</strong> ${Math.min(parseFloat(hrs),40).toFixed(2)} | <strong>Overtime Hours:</strong> <span style="color:${ot>0?'#c0392b':'#27ae60'}">${otHrs}</span> | <strong>Total Hours:</strong> ${hrs}</div></div></div>`;
    try{await transporter.sendMail({from:'"KVM Door Systems" <'+settings.smtp_user+'>',to:user.email,subject:'Weekly Timecard — '+data.name+' — Week of '+targetWeek,html});sent++;}catch(e2){console.error('Timecard email failed:',data.name,e2.message);}
  }
  res.json({ok:true,sent,total:Object.keys(byUser).length});
});

// ─── ATTENDANCE ───────────────────────────────────────────────────────────────
const SHIFT_START_HOUR=6;const SHIFT_START_MIN=0;const TARDY_GRACE_MINS=25;
function getQuarter(dateStr){const m=parseInt(dateStr.split('-')[1]);return m<=3?'Q1':m<=6?'Q2':m<=9?'Q3':'Q4';}
function getQuarterStart(quarter,year){const s={Q1:`${year}-01-01`,Q2:`${year}-04-01`,Q3:`${year}-07-01`,Q4:`${year}-10-01`};return s[quarter];}
function getQuarterEnd(quarter,year){const e={Q1:`${year}-03-31`,Q2:`${year}-06-30`,Q3:`${year}-09-30`,Q4:`${year}-12-31`};return e[quarter];}
function checkTardiness(userId,userName,clockInTime){
  const d=new Date(clockInTime);const dateStr=d.toISOString().split('T')[0];
  const shiftStart=new Date(dateStr+'T0'+SHIFT_START_HOUR+':'+String(SHIFT_START_MIN).padStart(2,'0')+':00');
  const minutesLate=Math.floor((d-shiftStart)/60000);
  if(minutesLate>TARDY_GRACE_MINS){
    const existing=get('SELECT id FROM attendance WHERE user_id=? AND event_date=? AND event_type=?',[userId,dateStr,'tardy']);
    if(!existing){
      const quarter=getQuarter(dateStr);const year=parseInt(dateStr.split('-')[0]);
      runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,minutes_late,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?,?)',
        [userId,userName,dateStr,'tardy',minutesLate,`Clocked in ${minutesLate} minutes late`,'system',quarter,year]);
    }
  }
}
app.get('/api/attendance/my',requireAuth,(req,res)=>{
  const year=new Date().getFullYear();const quarter=getQuarter(new Date().toISOString().split('T')[0]);
  const qStart=getQuarterStart(quarter,year);const qEnd=getQuarterEnd(quarter,year);
  const events=all('SELECT * FROM attendance WHERE user_id=? ORDER BY event_date DESC',[req.session.userId]);
  const callins=all('SELECT * FROM callins WHERE user_id=? ORDER BY call_in_date DESC',[req.session.userId]);
  const recognition=all('SELECT * FROM attendance_recognition WHERE user_id=? ORDER BY year DESC,quarter DESC',[req.session.userId]);
  res.json({events,callins,thisQEvents:events.filter(e=>e.event_date>=qStart&&e.event_date<=qEnd),thisQCallins:callins.filter(c=>c.call_in_date>=qStart&&c.call_in_date<=qEnd),recognition,quarter,year});
});
app.get('/api/attendance/all',requireAdmin,(req,res)=>{
  const {quarter,year}=req.query;
  let events,callins;
  if(quarter&&year){
    const qStart=getQuarterStart(quarter,parseInt(year));const qEnd=getQuarterEnd(quarter,parseInt(year));
    events=all('SELECT * FROM attendance WHERE event_date>=? AND event_date<=? ORDER BY user_name,event_date',[qStart,qEnd]);
    callins=all('SELECT * FROM callins WHERE call_in_date>=? AND call_in_date<=? ORDER BY user_name,call_in_date',[qStart,qEnd]);
  } else {
    events=all('SELECT * FROM attendance ORDER BY event_date DESC LIMIT 500');
    callins=all('SELECT * FROM callins ORDER BY call_in_date DESC LIMIT 200');
  }
  res.json({events,callins});
});
app.get('/api/attendance/report',requireAdmin,(req,res)=>{
  const y=parseInt(req.query.year)||new Date().getFullYear();const q=req.query.quarter||getQuarter(new Date().toISOString().split('T')[0]);
  const qStart=getQuarterStart(q,y);const qEnd=getQuarterEnd(q,y);
  const users=all('SELECT id,first_name,last_name,role,department FROM users WHERE is_admin=0 ORDER BY first_name');
  const events=all('SELECT * FROM attendance WHERE event_date>=? AND event_date<=?',[qStart,qEnd]);
  const callins=all('SELECT * FROM callins WHERE call_in_date>=? AND call_in_date<=?',[qStart,qEnd]);
  const recognition=all('SELECT * FROM attendance_recognition WHERE quarter=? AND year=?',[q,y]);
  const report=users.map(u=>{
    const uEvents=events.filter(e=>e.user_id===u.id);const uCallins=callins.filter(c=>c.user_id===u.id);
    const tardies=uEvents.filter(e=>e.event_type==='tardy');const absences=uEvents.filter(e=>e.event_type==='absence');
    const earlyDepartures=uEvents.filter(e=>e.event_type==='early_departure');const ncns=uCallins.filter(c=>c.call_in_type==='No Call No Show');
    const isPerfect=tardies.length===0&&uCallins.length===0&&absences.length===0;
    return{user_id:u.id,name:u.first_name+(u.last_name?' '+u.last_name:''),role:u.role,department:u.department,tardies:tardies.length,callins:uCallins.length,absences:absences.length,early_departures:earlyDepartures.length,ncns:ncns.length,is_perfect:isPerfect,recognized:recognition.some(r=>r.user_id===u.id),tardy_details:tardies,callin_details:uCallins};
  });
  res.json({quarter:q,year:y,qStart,qEnd,report});
});
app.get('/api/attendance/brief',requireAuth,(req,res)=>{
  const today=new Date().toISOString().split('T')[0];
  const ptoOff=all(`SELECT user_id,user_name,type,start_date,end_date FROM pto_requests WHERE status='approved' AND start_date<=? AND end_date>=? ORDER BY user_name`,[today,today]);
  const calledIn=all(`SELECT user_id,user_name,call_in_type,notes FROM callins WHERE call_in_date=? ORDER BY user_name`,[today]);
  const tardy=all(`SELECT user_id,user_name,minutes_late,notes FROM attendance WHERE event_date=? AND event_type='tardy' ORDER BY user_name`,[today]);
  res.json({date:today,off:ptoOff,callins:calledIn,tardy:tardy});
});

app.post('/api/attendance/callin',requireAdmin,async(req,res)=>{
  const {user_id,call_in_date,call_in_type,notes}=req.body;
  if(!user_id||!call_in_date||!call_in_type) return res.status(400).json({error:'Missing fields'});
  const user=get('SELECT first_name,last_name,email FROM users WHERE id=?',[user_id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const user_name=user.first_name+(user.last_name?' '+user.last_name:'');
  const admin=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const admin_name=admin.first_name+(admin.last_name?' '+admin.last_name:'');
  const id=runGetId('INSERT INTO callins (user_id,user_name,call_in_date,call_in_type,notes,logged_by) VALUES (?,?,?,?,?,?)',[user_id,user_name,call_in_date,call_in_type,notes||'',admin_name]);
  const quarter=getQuarter(call_in_date);const year=parseInt(call_in_date.split('-')[0]);
  runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?)',
    [user_id,user_name,call_in_date,'callin',call_in_type+(notes?' — '+notes:''),admin_name,quarter,year]);
  const settings=getSettings();
  if(user.email&&settings.smtp_host&&settings.smtp_user&&settings.smtp_pass){
    try{
      const transporter=nodemailer.createTransport({host:settings.smtp_host,port:parseInt(settings.smtp_port)||587,secure:false,auth:{user:settings.smtp_user,pass:settings.smtp_pass},tls:{rejectUnauthorized:false}});
      await transporter.sendMail({from:'"KVM Door Systems" <'+settings.smtp_user+'>',to:user.email,subject:`Attendance Logged — ${call_in_type} — ${call_in_date}`,html:`<p>Hi ${user.first_name}, ${call_in_type} has been logged for ${call_in_date}. Contact your manager with questions.</p>`});
      run('UPDATE callins SET notified=1 WHERE id=?',[id]);
    }catch(e){console.error('Call-in email error:',e.message);}
  }
  res.json({id});
});
app.post('/api/attendance/event',requireAdmin,(req,res)=>{
  const {user_id,event_date,event_type,minutes_late,notes}=req.body;
  if(!user_id||!event_date||!event_type) return res.status(400).json({error:'Missing fields'});
  const user=get('SELECT first_name,last_name FROM users WHERE id=?',[user_id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const user_name=user.first_name+(user.last_name?' '+user.last_name:'');
  const admin=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  const admin_name=admin.first_name+(admin.last_name?' '+admin.last_name:'');
  const quarter=getQuarter(event_date);const year=parseInt(event_date.split('-')[0]);
  const id=runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,minutes_late,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?,?)',
    [user_id,user_name,event_date,event_type,minutes_late||0,notes||'',admin_name,quarter,year]);
  res.json({id});
});
app.delete('/api/attendance/:id',requireAdmin,(req,res)=>{run('DELETE FROM attendance WHERE id=?',[req.params.id]);res.json({ok:true});});
app.delete('/api/attendance/callin/:id',requireAdmin,(req,res)=>{run('DELETE FROM callins WHERE id=?',[req.params.id]);res.json({ok:true});});
app.post('/api/attendance/my-callin',requireAuth,async(req,res)=>{
  const {call_in_date,call_in_type,notes}=req.body;
  if(!call_in_date||!call_in_type) return res.status(400).json({error:'Missing fields'});
  const allowedTypes=['Sick','Personal','FMLA','Bereavement','Union Leave'];
  if(!allowedTypes.includes(call_in_type)) return res.status(400).json({error:'Invalid call-in type'});
  const existing=get('SELECT id FROM callins WHERE user_id=? AND call_in_date=?',[req.session.userId,call_in_date]);
  if(existing) return res.status(400).json({error:'You already have a call-in logged for that date.'});
  const user=get('SELECT first_name,last_name,email FROM users WHERE id=?',[req.session.userId]);
  const user_name=user.first_name+(user.last_name?' '+user.last_name:'');
  const id=runGetId('INSERT INTO callins (user_id,user_name,call_in_date,call_in_type,notes,logged_by) VALUES (?,?,?,?,?,?)',
    [req.session.userId,user_name,call_in_date,call_in_type,notes||'',user_name+' (self-reported)']);
  const quarter=getQuarter(call_in_date);const year=parseInt(call_in_date.split('-')[0]);
  runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?)',
    [req.session.userId,user_name,call_in_date,'callin',call_in_type+(notes?' — '+notes:''),user_name+' (self-reported)',quarter,year]);
  res.json({id,message:'Call-in submitted. Your manager has been notified.'});
});

// ─── PERFECT ATTENDANCE ───────────────────────────────────────────────────────
async function checkPerfectAttendance(quarter,year){
  const qStart=getQuarterStart(quarter,year);const qEnd=getQuarterEnd(quarter,year);
  const users=all('SELECT id,first_name,last_name FROM users WHERE is_admin=0');
  const events=all('SELECT user_id FROM attendance WHERE event_date>=? AND event_date<=?',[qStart,qEnd]);
  const callins=all('SELECT user_id FROM callins WHERE call_in_date>=? AND call_in_date<=?',[qStart,qEnd]);
  const eventUsers=new Set(events.map(e=>e.user_id));const callinUsers=new Set(callins.map(c=>c.user_id));
  const perfectEmployees=users.filter(u=>!eventUsers.has(u.id)&&!callinUsers.has(u.id));
  if(!perfectEmployees.length) return;
  const names=perfectEmployees.map(u=>u.first_name+(u.last_name?' '+u.last_name:'')).join(', ');
  const body=`Congratulations to the following employees for achieving Perfect Attendance in ${quarter} ${year}! 🏆\n\n${names}`;
  const existing=get('SELECT id FROM attendance_recognition WHERE quarter=? AND year=? AND announced=1',[quarter,year]);
  if(!existing){
    runGetId('INSERT INTO announcements (title,body,priority,author_name,created_at) VALUES (?,?,?,?,?)',
      [`🏆 Perfect Attendance — ${quarter} ${year}`,body,'info','KVM Door Systems',nowStr()]);
    perfectEmployees.forEach(u=>{
      const already=get('SELECT id FROM attendance_recognition WHERE user_id=? AND quarter=? AND year=?',[u.id,quarter,year]);
      if(!already) runGetId('INSERT INTO attendance_recognition (user_id,user_name,quarter,year,announced) VALUES (?,?,?,?,1)',
        [u.id,u.first_name+(u.last_name?' '+u.last_name:''),quarter,year,1]);
    });
  }
}
app.post('/api/attendance/perfect-check',requireAdmin,async(req,res)=>{
  const now=new Date();const qMap=[null,'Q1','Q1','Q1','Q2','Q2','Q2','Q3','Q3','Q3','Q4','Q4','Q4'];
  const q=qMap[now.getMonth()+1];const y=now.getFullYear();
  if(q) await checkPerfectAttendance(q,y);
  res.json({ok:true,quarter:q,year:y});
});
app.post('/api/attendance/daily-email',requireAdmin,async(req,res)=>{
  await sendDailyAttendanceEmail(req.body.group||'technicians');res.json({ok:true});
});

// ─── EXCEL EXPORT ─────────────────────────────────────────────────────────────
function addDaysServer(dateStr,n){const d=new Date(dateStr+'T00:00:00');d.setDate(d.getDate()+n);return d.toISOString().split('T')[0];}
function buildTimecardExcel(week){
  const entries=all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name,clock_in',[week,'out']);
  const users=all('SELECT id,first_name,last_name,role,department FROM users WHERE is_admin=0 ORDER BY first_name');
  const wb=XLSX.utils.book_new();
  const summaryData=[['Employee','Role','Department','Regular Hours','Overtime Hours','Total Hours','Week']];
  const byUser={};
  entries.forEach(e=>{if(!byUser[e.user_id]) byUser[e.user_id]={name:e.user_name,mins:0,entries:[]};byUser[e.user_id].mins+=e.total_minutes||0;byUser[e.user_id].entries.push(e);});
  users.forEach(u=>{
    const ud=byUser[u.id];const totalMins=ud?ud.mins:0;const regularMins=Math.min(totalMins,2400);const otMins=Math.max(0,totalMins-2400);
    summaryData.push([u.first_name+(u.last_name?' '+u.last_name:''),u.role||'',u.department||'',(regularMins/60).toFixed(2),(otMins/60).toFixed(2),(totalMins/60).toFixed(2),week]);
  });
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(summaryData),'Weekly Summary');
  users.forEach(u=>{
    const ud=byUser[u.id];const sheetData=[['Date','Day','Clock In','Clock Out','Hours','Type','Job Name','Notes']];
    if(ud) ud.entries.forEach(e=>{
      const d=new Date(e.clock_in);
      sheetData.push([d.toLocaleDateString('en-US'),d.toLocaleDateString('en-US',{weekday:'long'}),new Date(e.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}),e.clock_out?new Date(e.clock_out).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'Active',((e.total_minutes||0)/60).toFixed(2),e.clock_type+(e.is_union?' (Union)':''),e.job_name||'',e.notes||'']);
    });
    const safeName=(u.first_name+(u.last_name?' '+u.last_name:'')).replace(/[:\/?*\[\]]/g,'').slice(0,31);
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(sheetData),safeName);
  });
  return wb;
}
app.get('/api/timeclock/export',requireAdmin,(req,res)=>{
  const targetWeek=req.query.week||getWeekStart(new Date().toISOString().split('T')[0]);
  try{
    const wb=buildTimecardExcel(targetWeek);const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="KVM_Timecards_${targetWeek}.xlsx"`);
    res.send(buf);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/timeclock/my-history',requireAuth,(req,res)=>{
  const weeks=all('SELECT DISTINCT week_start FROM timeclock WHERE user_id=? ORDER BY week_start DESC LIMIT 12',[req.session.userId]);
  const entries=all('SELECT * FROM timeclock WHERE user_id=? ORDER BY clock_in DESC LIMIT 200',[req.session.userId]);
  res.json({weeks,entries});
});

// ─── DAILY ATTENDANCE EMAIL ───────────────────────────────────────────────────
async function sendDailyAttendanceEmail(group){
  const settings=getSettings();
  if(!settings.smtp_host||!settings.smtp_user||!settings.smtp_pass) return;
  const today=new Date().toISOString().split('T')[0];
  const allEmps=all('SELECT * FROM users WHERE is_admin=0 ORDER BY first_name');
  const isOffice=u=>OFFICE_DEPARTMENTS.map(d=>d.toLowerCase()).includes((u.department||'').toLowerCase().trim());
  const employees=group==='office'?allEmps.filter(u=>isOffice(u)):allEmps.filter(u=>!isOffice(u));
  if(!employees.length) return;
  const clockedInToday=all("SELECT DISTINCT user_id,user_name,clock_in,clock_type,job_name FROM timeclock WHERE clock_in LIKE ? ORDER BY clock_in",[today+'%']);
  const clockedInIds=new Set(clockedInToday.map(e=>e.user_id));
  const callInsToday=all("SELECT * FROM callins WHERE call_in_date=?",[today]);
  const callinIds=new Set(callInsToday.map(c=>c.user_id));
  const clocked=employees.filter(u=>clockedInIds.has(u.id));
  const calledIn=employees.filter(u=>callinIds.has(u.id)&&!clockedInIds.has(u.id));
  const notIn=employees.filter(u=>!clockedInIds.has(u.id)&&!callinIds.has(u.id));
  const groupLabel=group==='office'?'Office Staff':'Field Technicians';
  const makeRow=(u,status,statusColor,detail='')=>`<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:500">${u.first_name}${u.last_name?' '+u.last_name:''}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#888;font-size:12px">${u.role||u.department||'—'}</td><td style="padding:8px 12px;border-bottom:1px solid #eee"><span style="background:${statusColor}22;color:${statusColor};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold">${status}</span></td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888">${detail}</td></tr>`;
  let rows='';
  clocked.forEach(u=>{const entry=clockedInToday.find(e=>e.user_id===u.id);const timeIn=entry?new Date(entry.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'';rows+=makeRow(u,'✓ IN','#27ae60',timeIn+(entry&&entry.job_name?' — '+entry.job_name:''));});
  calledIn.forEach(u=>{const ci=callInsToday.find(c=>c.user_id===u.id);rows+=makeRow(u,ci?ci.call_in_type.toUpperCase():'CALLED IN','#e67e22',ci?ci.notes||'':'');});
  notIn.forEach(u=>{rows+=makeRow(u,'✗ NOT IN','#c0392b','');});
  const html=`<div style="font-family:Arial,sans-serif;max-width:700px"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623">Daily Attendance — ${groupLabel}</h2><div style="display:flex;gap:20px;margin-bottom:20px"><div style="text-align:center;padding:12px 20px;background:#f0faf4;border-radius:8px;border-top:3px solid #27ae60"><div style="font-size:28px;font-weight:bold;color:#27ae60">${clocked.length}</div><div style="font-size:12px;color:#888">In</div></div><div style="text-align:center;padding:12px 20px;background:#fff8f0;border-radius:8px;border-top:3px solid #e67e22"><div style="font-size:28px;font-weight:bold;color:#e67e22">${calledIn.length}</div><div style="font-size:12px;color:#888">Called In</div></div><div style="text-align:center;padding:12px 20px;background:#fdf0f0;border-radius:8px;border-top:3px solid #c0392b"><div style="font-size:28px;font-weight:bold;color:#c0392b">${notIn.length}</div><div style="font-size:12px;color:#888">Not In</div></div></div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f5f5f5"><th style="padding:10px 12px;text-align:left">Employee</th><th style="padding:10px 12px;text-align:left">Role</th><th style="padding:10px 12px;text-align:left">Status</th><th style="padding:10px 12px;text-align:left">Details</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  const recipients=[...new Set(all("SELECT email FROM users WHERE (is_admin=1 OR department LIKE '%Manager%' OR role LIKE '%Manager%' OR department LIKE '%Management%') AND email!=''").map(u=>u.email))];
  if(!recipients.length) return;
  const transporter=nodemailer.createTransport({host:settings.smtp_host,port:parseInt(settings.smtp_port)||587,secure:false,auth:{user:settings.smtp_user,pass:settings.smtp_pass},tls:{rejectUnauthorized:false}});
  try{await transporter.sendMail({from:'"KVM Door Systems" <'+settings.smtp_user+'>',to:recipients.join(','),subject:`Daily Attendance — ${groupLabel} — ${today}`,html});}
  catch(e){console.error('Daily attendance email error:',e.message);}
}

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
cron.schedule('0 6 * * 1',async()=>{
  const today=new Date().toISOString().split('T')[0];const lastMonday=new Date(today+'T00:00:00');lastMonday.setDate(lastMonday.getDate()-7);const lastWeek=lastMonday.toISOString().split('T')[0];
  try{
    const wb=buildTimecardExcel(lastWeek);const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});const settings=getSettings();
    if(!settings.smtp_host||!settings.smtp_user||!settings.smtp_pass) return;
    const adminEmails=all("SELECT email FROM users WHERE is_admin=1 AND email!=''").map(u=>u.email);if(!adminEmails.length) return;
    const transporter=nodemailer.createTransport({host:settings.smtp_host,port:parseInt(settings.smtp_port)||587,secure:false,auth:{user:settings.smtp_user,pass:settings.smtp_pass},tls:{rejectUnauthorized:false}});
    await transporter.sendMail({from:'"KVM Door Systems" <'+settings.smtp_user+'>',to:adminEmails.join(','),subject:`KVM Weekly Timecards — Week of ${lastWeek}`,html:`<div style="font-family:Arial;padding:20px"><h2 style="color:#F5A623">Weekly Timecard Report</h2><p>Attached is the timecard Excel for the week of <strong>${lastWeek}</strong>.</p></div>`,attachments:[{filename:`KVM_Timecards_${lastWeek}.xlsx`,content:buf,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}]});
    console.log('  Weekly timecard Excel sent');
  }catch(e){console.error('Weekly export error:',e.message);}
},{timezone:'America/Detroit'});

cron.schedule('0 7 1 1,4,7,10 *',async()=>{
  const today=new Date();const year=today.getFullYear();const month=today.getMonth()+1;
  const prevQ={1:'Q4',4:'Q1',7:'Q2',10:'Q3'};const prevY={1:year-1,4:year,7:year,10:year};
  const q=prevQ[month];const y=prevY[month];if(q&&y) await checkPerfectAttendance(q,y);
},{timezone:'America/Detroit'});

cron.schedule('0 7 * * 1-5',async()=>{await sendDailyAttendanceEmail('technicians');},{timezone:'America/Detroit'});
cron.schedule('0 9 * * 1-5',async()=>{await sendDailyAttendanceEmail('office');},{timezone:'America/Detroit'});

cron.schedule('0 17 * * 1-5',async()=>{
  const changed=all("SELECT * FROM customers WHERE status='active' AND updated_at > datetime('now','-1 day') ORDER BY company_name");
  if(!changed.length) return;
  const settings=getSettings();if(!settings.smtp_host||!settings.smtp_user||!settings.smtp_pass){runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',['auto_sync',changed.length,'skipped','Email not configured']);return;}
  let iif=['!CUST','NAME','REFNUM','BSTYPE','ACCNUM','EMAIL','ADDR1','ADDR2','ADDR3','ADDR4','CUST','TERMS'].join('\t')+'\n';
  changed.forEach(c=>{iif+='CUST\t'+[c.company_name,c.qb_customer_id||'','','',c.qb_customer_id||'',c.billing_email||'',c.billing_address||'',c.billing_city||'',c.billing_state||'',c.billing_zip||'','TRUE',c.credit_terms||'Net 30'].join('\t')+'\n';});
  const adminEmails=[...new Set(all("SELECT email FROM users WHERE (is_admin=1 OR role_type='manager') AND email!=''").map(u=>u.email))];
  if(!adminEmails.length) return;
  try{
    const transporter=nodemailer.createTransport({host:settings.smtp_host,port:parseInt(settings.smtp_port)||587,secure:false,auth:{user:settings.smtp_user,pass:settings.smtp_pass},tls:{rejectUnauthorized:false}});
    const dateStr=new Date().toISOString().split('T')[0];
    await transporter.sendMail({from:'"KVM Door Systems" <'+settings.smtp_user+'>',to:adminEmails.join(','),subject:`Daily QB Customer Sync — ${changed.length} update(s) — ${dateStr}`,html:`<p>${changed.length} customer records updated today. IIF file attached.</p>`,attachments:[{filename:`KVM_QB_Sync_${dateStr}.iif`,content:iif,contentType:'text/plain'}]});
    runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',['auto_sync',changed.length,'success','IIF emailed']);
  }catch(e){runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',['auto_sync',changed.length,'error',e.message]);}
},{timezone:'America/Detroit'});

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────
function requireCustomerAccess(req,res,next){if(!req.session.userId) return res.status(401).json({error:'Not authenticated'});next();}
function generateJobNumber(){
  const now=new Date();const mm=String(now.getMonth()+1).padStart(2,'0');const yy=String(now.getFullYear()).slice(-2);const prefix=mm+yy;
  const lastJob=get("SELECT job_number FROM job_numbers WHERE prefix=? ORDER BY sequence DESC LIMIT 1",[prefix]);
  const seq=lastJob?(parseInt(lastJob.job_number.split('-')[1])+1):1;const jobNum=prefix+'-'+seq;
  runGetId('INSERT INTO job_numbers (prefix,job_number,sequence) VALUES (?,?,?)',[prefix,jobNum,seq]);return jobNum;
}
app.get('/api/customers',requireCustomerAccess,(req,res)=>{
  const {search,type,status}=req.query;
  let sql='SELECT c.*,u.first_name || " " || u.last_name as salesperson_name FROM customers c LEFT JOIN users u ON c.assigned_salesperson_id=u.id WHERE 1=1';const params=[];
  if(search){sql+=' AND (c.company_name LIKE ? OR c.billing_city LIKE ?)';params.push('%'+search+'%','%'+search+'%');}
  if(type){sql+=' AND c.customer_type=?';params.push(type);}
  if(status){sql+=' AND c.status=?';params.push(status);}else{sql+=" AND c.status='active'";}
  sql+=' ORDER BY c.company_name';res.json(all(sql,params));
});
app.get('/api/customers/search',requireCustomerAccess,(req,res)=>{
  const q=req.query.q||'';res.json(all("SELECT id,company_name,customer_type,billing_city,billing_state,is_partner_company FROM customers WHERE company_name LIKE ? AND status='active' ORDER BY company_name LIMIT 20",['%'+q+'%']));
});
app.get('/api/customers/export/qb-iif',requireAdmin,(req,res)=>{
  const customers=all("SELECT * FROM customers WHERE status='active' ORDER BY company_name");
  let iif=['!CUST','NAME','REFNUM','BSTYPE','ACCNUM','EMAIL','ADDR1','ADDR2','ADDR3','ADDR4','CUST','TERMS'].join('\t')+'\n';
  customers.forEach(c=>{iif+='CUST\t'+[c.company_name,c.qb_customer_id||'','','',c.qb_customer_id||'',c.billing_email||'',c.billing_address||'',c.billing_city||'',c.billing_state||'',c.billing_zip||'','TRUE',c.credit_terms||'Net 30'].join('\t')+'\n';});
  runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',['customer_export',customers.length,'success','Manual IIF export']);
  res.setHeader('Content-Type','text/plain');res.setHeader('Content-Disposition','attachment; filename="KVM_Customers_QB_'+new Date().toISOString().split('T')[0]+'.iif"');res.send(iif);
});
app.get('/api/customers/:id',requireCustomerAccess,(req,res)=>{
  const c=get('SELECT * FROM customers WHERE id=?',[req.params.id]);if(!c) return res.status(404).json({error:'Customer not found'});
  res.json({...c,sites:all('SELECT * FROM customer_sites WHERE customer_id=? ORDER BY site_name',[req.params.id]),contacts:all('SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC,last_name',[req.params.id]),equipment:all('SELECT * FROM customer_equipment WHERE customer_id=? ORDER BY site_id,equipment_type',[req.params.id]),docs:all('SELECT id,customer_id,doc_type,doc_name,file_name,file_type,file_size,notes,uploaded_at FROM partner_documents WHERE customer_id=?',[req.params.id])});
});
app.post('/api/customers',requireCustomerAccess,(req,res)=>{
  const {company_name,customer_type,is_partner_company,qb_customer_id,billing_address,billing_city,billing_state,billing_zip,billing_email,billing_phone,billing_fax,credit_terms,tax_exempt,tax_exempt_number,union_required,requires_certified_payroll,partner_labor_rate_notes,partner_billing_hours,partner_work_order_instructions,partner_checkin_instructions,partner_billing_email,partner_billing_notes,internal_notes,assigned_salesperson_id}=req.body;
  if(!company_name) return res.status(400).json({error:'Company name is required'});
  const id=runGetId(`INSERT INTO customers (company_name,customer_type,is_partner_company,qb_customer_id,billing_address,billing_city,billing_state,billing_zip,billing_email,billing_phone,billing_fax,credit_terms,tax_exempt,tax_exempt_number,union_required,requires_certified_payroll,partner_labor_rate_notes,partner_billing_hours,partner_work_order_instructions,partner_checkin_instructions,partner_billing_email,partner_billing_notes,internal_notes,assigned_salesperson_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
    [company_name,customer_type||'End User',is_partner_company?1:0,qb_customer_id||'',billing_address||'',billing_city||'',billing_state||'',billing_zip||'',billing_email||'',billing_phone||'',billing_fax||'',credit_terms||'Net 30',tax_exempt?1:0,tax_exempt_number||'',union_required?1:0,requires_certified_payroll?1:0,partner_labor_rate_notes||'',partner_billing_hours||0,partner_work_order_instructions||'',partner_checkin_instructions||'',partner_billing_email||'',partner_billing_notes||'',internal_notes||'',assigned_salesperson_id||0]);
  res.json({id});
});
app.put('/api/customers/:id',requireCustomerAccess,(req,res)=>{
  const {company_name,customer_type,is_partner_company,qb_customer_id,billing_address,billing_city,billing_state,billing_zip,billing_email,billing_phone,billing_fax,credit_terms,tax_exempt,tax_exempt_number,union_required,requires_certified_payroll,partner_labor_rate_notes,partner_billing_hours,partner_work_order_instructions,partner_checkin_instructions,partner_billing_email,partner_billing_notes,internal_notes,assigned_salesperson_id,status}=req.body;
  run(`UPDATE customers SET company_name=?,customer_type=?,is_partner_company=?,qb_customer_id=?,billing_address=?,billing_city=?,billing_state=?,billing_zip=?,billing_email=?,billing_phone=?,billing_fax=?,credit_terms=?,tax_exempt=?,tax_exempt_number=?,union_required=?,requires_certified_payroll=?,partner_labor_rate_notes=?,partner_billing_hours=?,partner_work_order_instructions=?,partner_checkin_instructions=?,partner_billing_email=?,partner_billing_notes=?,internal_notes=?,assigned_salesperson_id=?,status=?,updated_at=datetime('now') WHERE id=?`,
    [company_name,customer_type,is_partner_company?1:0,qb_customer_id||'',billing_address||'',billing_city||'',billing_state||'',billing_zip||'',billing_email||'',billing_phone||'',billing_fax||'',credit_terms||'Net 30',tax_exempt?1:0,tax_exempt_number||'',union_required?1:0,requires_certified_payroll?1:0,partner_labor_rate_notes||'',partner_billing_hours||0,partner_work_order_instructions||'',partner_checkin_instructions||'',partner_billing_email||'',partner_billing_notes||'',internal_notes||'',assigned_salesperson_id||0,status||'active',req.params.id]);
  res.json({ok:true});
});
app.delete('/api/customers/:id',requireAdmin,(req,res)=>{run("UPDATE customers SET status='inactive' WHERE id=?",[req.params.id]);res.json({ok:true});});
app.get('/api/customers/:id/sites',requireCustomerAccess,(req,res)=>{res.json(all('SELECT * FROM customer_sites WHERE customer_id=? AND status=? ORDER BY site_name',[req.params.id,'active']));});
app.post('/api/customers/:id/sites',requireCustomerAccess,(req,res)=>{
  const {site_name,store_number,address,city,state,zip,site_notes,access_instructions}=req.body;
  res.json({id:runGetId('INSERT INTO customer_sites (customer_id,site_name,store_number,address,city,state,zip,site_notes,access_instructions) VALUES (?,?,?,?,?,?,?,?,?)',[req.params.id,site_name||'',store_number||'',address||'',city||'',state||'',zip||'',site_notes||'',access_instructions||''])});
});
app.put('/api/customers/:cid/sites/:id',requireCustomerAccess,(req,res)=>{
  const {site_name,store_number,address,city,state,zip,site_notes,access_instructions,status}=req.body;
  run('UPDATE customer_sites SET site_name=?,store_number=?,address=?,city=?,state=?,zip=?,site_notes=?,access_instructions=?,status=? WHERE id=? AND customer_id=?',[site_name||'',store_number||'',address||'',city||'',state||'',zip||'',site_notes||'',access_instructions||'',status||'active',req.params.id,req.params.cid]);res.json({ok:true});
});
app.delete('/api/customers/:cid/sites/:id',requireAdmin,(req,res)=>{run("UPDATE customer_sites SET status='inactive' WHERE id=? AND customer_id=?",[req.params.id,req.params.cid]);res.json({ok:true});});
app.post('/api/customers/:id/contacts',requireCustomerAccess,(req,res)=>{
  const {first_name,last_name,title,phone,phone2,email,site_id,is_primary,is_billing_contact,notes}=req.body;
  if(!first_name) return res.status(400).json({error:'First name required'});
  if(is_primary) run('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?',[req.params.id]);
  res.json({id:runGetId('INSERT INTO customer_contacts (customer_id,site_id,first_name,last_name,title,phone,phone2,email,is_primary,is_billing_contact,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[req.params.id,site_id||0,first_name,last_name||'',title||'',phone||'',phone2||'',email||'',is_primary?1:0,is_billing_contact?1:0,notes||''])});
});
app.put('/api/customers/:cid/contacts/:id',requireCustomerAccess,(req,res)=>{
  const {first_name,last_name,title,phone,phone2,email,site_id,is_primary,is_billing_contact,notes}=req.body;
  if(is_primary) run('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?',[req.params.cid]);
  run('UPDATE customer_contacts SET first_name=?,last_name=?,title=?,phone=?,phone2=?,email=?,site_id=?,is_primary=?,is_billing_contact=?,notes=? WHERE id=? AND customer_id=?',[first_name,last_name||'',title||'',phone||'',phone2||'',email||'',site_id||0,is_primary?1:0,is_billing_contact?1:0,notes||'',req.params.id,req.params.cid]);res.json({ok:true});
});
app.delete('/api/customers/:cid/contacts/:id',requireAdmin,(req,res)=>{run('DELETE FROM customer_contacts WHERE id=? AND customer_id=?',[req.params.id,req.params.cid]);res.json({ok:true});});
app.post('/api/customers/:id/equipment',requireCustomerAccess,(req,res)=>{
  const {site_id,equipment_type,manufacturer,model,serial_number,size,install_date,warranty_expiry,condition,location_in_site,notes}=req.body;
  res.json({id:runGetId('INSERT INTO customer_equipment (customer_id,site_id,equipment_type,manufacturer,model,serial_number,size,install_date,warranty_expiry,condition,location_in_site,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[req.params.id,site_id||0,equipment_type||'',manufacturer||'',model||'',serial_number||'',size||'',install_date||'',warranty_expiry||'',condition||'',location_in_site||'',notes||''])});
});
app.put('/api/customers/:cid/equipment/:id',requireCustomerAccess,(req,res)=>{
  const {site_id,equipment_type,manufacturer,model,serial_number,size,install_date,last_service_date,warranty_expiry,condition,location_in_site,notes}=req.body;
  run('UPDATE customer_equipment SET site_id=?,equipment_type=?,manufacturer=?,model=?,serial_number=?,size=?,install_date=?,last_service_date=?,warranty_expiry=?,condition=?,location_in_site=?,notes=? WHERE id=? AND customer_id=?',[site_id||0,equipment_type||'',manufacturer||'',model||'',serial_number||'',size||'',install_date||'',last_service_date||'',warranty_expiry||'',condition||'',location_in_site||'',notes||'',req.params.id,req.params.cid]);res.json({ok:true});
});
app.delete('/api/customers/:cid/equipment/:id',requireAdmin,(req,res)=>{run('DELETE FROM customer_equipment WHERE id=? AND customer_id=?',[req.params.id,req.params.cid]);res.json({ok:true});});
app.post('/api/customers/:id/docs',requireCustomerAccess,(req,res)=>{
  const {doc_type,doc_name,file_name,file_data,file_type,file_size,notes}=req.body;
  if(!doc_name||!file_data) return res.status(400).json({error:'Missing doc name or file'});
  res.json({id:runGetId('INSERT INTO partner_documents (customer_id,doc_type,doc_name,file_name,file_data,file_type,file_size,notes) VALUES (?,?,?,?,?,?,?,?)',[req.params.id,doc_type||'',doc_name,file_name||'',file_data,file_type||'',file_size||0,notes||''])});
});
app.get('/api/customers/:id/docs/:docId/download',requireCustomerAccess,(req,res)=>{
  const doc=get('SELECT * FROM partner_documents WHERE id=? AND customer_id=?',[req.params.docId,req.params.id]);
  if(!doc) return res.status(404).json({error:'Not found'});
  const buf=Buffer.from(doc.file_data,'base64');
  res.setHeader('Content-Type',doc.file_type||'application/octet-stream');res.setHeader('Content-Disposition','attachment; filename="'+doc.file_name+'"');res.send(buf);
});
app.delete('/api/customers/:cid/docs/:id',requireAdmin,(req,res)=>{run('DELETE FROM partner_documents WHERE id=? AND customer_id=?',[req.params.id,req.params.cid]);res.json({ok:true});});
app.get('/api/qb/sync-log',requireAdmin,(req,res)=>{res.json(all('SELECT * FROM qb_sync_log ORDER BY created_at DESC LIMIT 30'));});
app.post('/api/customers/import/qb-iif',requireAdmin,(req,res)=>{
  const {iif_content}=req.body;if(!iif_content) return res.status(400).json({error:'No IIF content provided'});
  const lines=iif_content.split('\n').filter(l=>l.trim());let imported=0,skipped=0;const errors=[];
  lines.forEach(line=>{
    const parts=line.split('\t');if(!parts[0]||parts[0].trim()!=='CUST') return;const name=(parts[1]||'').trim();if(!name) return;
    const existing=get("SELECT id FROM customers WHERE company_name=?",[name]);if(existing){skipped++;return;}
    try{runGetId(`INSERT INTO customers (company_name,qb_customer_id,billing_phone,billing_email,billing_address,billing_city,billing_state,billing_zip,credit_terms,status) VALUES (?,?,?,?,?,?,?,?,?,?)`,[name,parts[2]||'',parts[7]||'',parts[8]||'',parts[12]||'',parts[13]||'',parts[14]||'',parts[15]||'',parts[20]||'Net 30','active']);imported++;}
    catch(e){errors.push(name+': '+e.message);}
  });
  res.json({ok:true,imported,skipped,errors});
});

// ─── ACHIEVEMENTS ─────────────────────────────────────────────────────────────
app.get('/api/achievements/my',requireAuth,(req,res)=>{res.json(all('SELECT * FROM achievements WHERE user_id=? ORDER BY awarded_at DESC',[req.session.userId]));});
app.get('/api/achievements/user/:id',requireManager,(req,res)=>{res.json(all('SELECT * FROM achievements WHERE user_id=? ORDER BY awarded_at DESC',[req.params.id]));});
app.get('/api/achievements/all',requireAdmin,(req,res)=>{res.json(all('SELECT * FROM achievements ORDER BY awarded_at DESC'));});
app.post('/api/achievements',requireManager,(req,res)=>{
  const {user_id,title,description,icon}=req.body;if(!user_id||!title) return res.status(400).json({error:'Missing fields'});
  const user=get('SELECT first_name,last_name FROM users WHERE id=?',[user_id]);if(!user) return res.status(404).json({error:'User not found'});
  const awarder=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  res.json({id:runGetId('INSERT INTO achievements (user_id,user_name,title,description,icon,awarded_by) VALUES (?,?,?,?,?,?)',
    [user_id,user.first_name+(user.last_name?' '+user.last_name:''),title,description||'',icon||'🏆',awarder.first_name+(awarder.last_name?' '+awarder.last_name:'')])});
});
app.delete('/api/achievements/:id',requireAdmin,(req,res)=>{run('DELETE FROM achievements WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── EMERGENCY RESET ──────────────────────────────────────────────────────────
app.post('/api/emergency-reset',(req,res)=>{
  const {token,new_password}=req.body;const expectedToken=process.env.RESET_TOKEN||'';
  if(!expectedToken||token!==expectedToken) return res.status(403).json({error:'Invalid reset token'});
  if(!new_password||new_password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const admin=get('SELECT id,username FROM users WHERE is_admin=1 ORDER BY id LIMIT 1');
  if(!admin) return res.status(404).json({error:'No admin user found'});
  run('UPDATE users SET password=? WHERE id=?',[bcrypt.hashSync(new_password,10),admin.id]);
  res.json({ok:true,username:admin.username,message:'Password reset successfully'});
});
app.post('/api/fix-roles',requireAuth,(req,res)=>{
  const u=get('SELECT is_admin FROM users WHERE id=?',[req.session.userId]);
  if(!u||!u.is_admin) return res.status(403).json({error:'Only original admin users can run this fix'});
  db.run("UPDATE users SET role_type='global_admin' WHERE is_admin=1");
  db.run("UPDATE users SET role_type='technician' WHERE is_admin=0 AND (role_type IS NULL OR role_type='' OR role_type='admin')");
  saveDb();res.json({ok:true,global_admins:all("SELECT username,role_type FROM users WHERE role_type='global_admin'")});
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CLAUDE API PROXY ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/claude', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set on server. Add it in Render environment variables.' } });
  try {
    const https = require('https');
    const payload = Buffer.from(JSON.stringify(req.body));
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': payload.length
      }
    };
    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => { res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' }); res.end(data); });
    });
    apiReq.on('error', e => res.status(500).json({ error: { message: e.message } }));
    apiReq.write(payload);
    apiReq.end();
  } catch(e) { res.status(500).json({ error: { message: e.message } }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── QUOTES ROUTES ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/quotes', requireAuth, (req, res) => {
  const role = getUserRole(req.session.userId);
  const isAdmin = ADMIN_ROLES.includes(role);
  const rows = isAdmin
    ? all('SELECT id,quote_number,rep_name,client_name,project_name,total,status,created_at,updated_at FROM quotes ORDER BY updated_at DESC')
    : all('SELECT id,quote_number,rep_name,client_name,project_name,total,status,created_at,updated_at FROM quotes WHERE rep_id=? ORDER BY updated_at DESC', [req.session.userId]);
  res.json(rows);
});

app.get('/api/quotes/:id', requireAuth, (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id=?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  const role = getUserRole(req.session.userId);
  if (!ADMIN_ROLES.includes(role) && q.rep_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  try { q.scopes = JSON.parse(q.scopes || '[]'); } catch(e) { q.scopes = []; }
  try { q.options = JSON.parse(q.options || '[]'); } catch(e) { q.options = []; }
  res.json(q);
});

app.post('/api/quotes', requireAuth, (req, res) => {
  const u = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const rep_name = u.first_name + (u.last_name ? ' ' + u.last_name : '');
  const { quote_number, customer_id, site_id, client_name, contact_name, address, email, phone, project_name, scope_summary, scopes, options, notes, subtotal, tax, total, valid_for, status } = req.body;
  // Phase 1A.1.1 — auto-assign next monthly job number.
  // Rules:
  //   1) Empty / whitespace → allocate fresh
  //   2) Matches the current "next" number (i.e. client just sent the peek value) → allocate fresh
  //   3) Already in use on another quote or project → allocate fresh (prevent duplicates)
  //   4) Otherwise → accept as-is (user typed a manual override like 0426-45A)
  let finalQuoteNum = (quote_number||'').trim();
  if (!finalQuoteNum) {
    try { finalQuoteNum = allocateNextJobNumber(); } catch(e) {}
  } else {
    // Check if this matches the current peek (server-driven; user didn't override)
    let shouldReallocate = false;
    try {
      const key = currentMonthKey();
      const row = get('SELECT last_seq FROM job_sequence WHERE month_key=?', [key]);
      const peekNext = `${key}-${(row ? row.last_seq||0 : 0) + 1}`;
      if (finalQuoteNum === peekNext) shouldReallocate = true;
    } catch(e) {}
    // Check for duplicate against existing quotes/projects
    if (!shouldReallocate) {
      const dupQ = get('SELECT id FROM quotes WHERE quote_number=? LIMIT 1', [finalQuoteNum]);
      const dupP = get('SELECT id FROM projects WHERE job_number=? LIMIT 1', [finalQuoteNum]);
      if (dupQ || dupP) shouldReallocate = true;
    }
    if (shouldReallocate) {
      try { finalQuoteNum = allocateNextJobNumber(); } catch(e) {}
    }
  }
  const id = runGetId(`INSERT INTO quotes (quote_number,rep_id,rep_name,customer_id,site_id,client_name,contact_name,address,email,phone,project_name,scope_summary,scopes,options,notes,subtotal,tax,total,valid_for,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [finalQuoteNum, req.session.userId, rep_name, parseInt(customer_id)||0, parseInt(site_id)||0, client_name||'', contact_name||'', address||'', email||'', phone||'', project_name||'', scope_summary||'', JSON.stringify(scopes||[]), JSON.stringify(options||[]), notes||'', subtotal||'', tax||'', total||'', valid_for||'30 days', status||'draft']);
  res.json({ id, quote_number: finalQuoteNum });
});

app.put('/api/quotes/:id', requireAuth, (req, res) => {
  const q = get('SELECT rep_id FROM quotes WHERE id=?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const role = getUserRole(req.session.userId);
  if (!ADMIN_ROLES.includes(role) && q.rep_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  const { quote_number, customer_id, site_id, client_name, contact_name, address, email, phone, project_name, scope_summary, scopes, options, notes, subtotal, tax, total, valid_for, status } = req.body;
  run(`UPDATE quotes SET quote_number=?,customer_id=?,site_id=?,client_name=?,contact_name=?,address=?,email=?,phone=?,project_name=?,scope_summary=?,scopes=?,options=?,notes=?,subtotal=?,tax=?,total=?,valid_for=?,status=?,updated_at=datetime('now') WHERE id=?`,
    [quote_number||'', parseInt(customer_id)||0, parseInt(site_id)||0, client_name||'', contact_name||'', address||'', email||'', phone||'', project_name||'', scope_summary||'', JSON.stringify(scopes||[]), JSON.stringify(options||[]), notes||'', subtotal||'', tax||'', total||'', valid_for||'30 days', status||'draft', req.params.id]);
  res.json({ ok: true });
});

// ═══ PHASE 1A.1 — Create Project from awarded Quote ═══
app.post('/api/quotes/:id/create-project', requireAuth, (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id=?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  // Phase 1A.2a — accept job_type ('project' | 'quick_job') and material_status from body
  const jobType = (req.body && req.body.job_type === 'quick_job') ? 'quick_job' : 'project';
  const materialStatus = (req.body && ['from_stock','need_to_order','ordered','partial','received'].includes(req.body.material_status))
                        ? req.body.material_status
                        : (jobType === 'quick_job' ? 'from_stock' : 'need_to_order');
  // Phase 1A.5 fix — accept material lead time
  const validLeadTimes = ['', 'from_stock','1_2_weeks','2_4_weeks','4_8_weeks','8_10_weeks','10_plus_weeks','custom'];
  const materialLeadTime = (req.body && validLeadTimes.includes(req.body.material_lead_time || ''))
                          ? (req.body.material_lead_time || '')
                          : '';
  // Auto-compute expected date from lead time if not provided
  let materialExpectedDate = (req.body && req.body.material_expected_date) || '';
  if (!materialExpectedDate && materialLeadTime) {
    const d = new Date();
    if      (materialLeadTime === 'from_stock')     { d.setDate(d.getDate() + 0);  materialExpectedDate = d.toISOString().split('T')[0]; }
    else if (materialLeadTime === '1_2_weeks')      { d.setDate(d.getDate() + 11); materialExpectedDate = d.toISOString().split('T')[0]; }
    else if (materialLeadTime === '2_4_weeks')      { d.setDate(d.getDate() + 21); materialExpectedDate = d.toISOString().split('T')[0]; }
    else if (materialLeadTime === '4_8_weeks')      { d.setDate(d.getDate() + 42); materialExpectedDate = d.toISOString().split('T')[0]; }
    else if (materialLeadTime === '8_10_weeks')     { d.setDate(d.getDate() + 63); materialExpectedDate = d.toISOString().split('T')[0]; }
    // 10_plus_weeks and custom intentionally leave date blank — user fills in when known
  }
  // Extract contract value from total field (may have $ or commas)
  const rawTotal = (q.total||'').toString().replace(/[^0-9.-]/g,'');
  const contractVal = rawTotal ? parseFloat(rawTotal).toFixed(2) : '';
  // Try to infer project name
  const projectName = q.project_name || q.scope_summary || ((jobType === 'quick_job' ? 'Quick Job' : 'Project') + ' from Quote ' + (q.quote_number||q.id));
  // Customer — prefer linked customer_id, fall back to client_name as text
  const customerId = q.customer_id || 0;
  const customerName = q.client_name || '';
  // Phase 1A.2b — inherit site_id from quote
  const siteId = q.site_id || 0;
  // Location — if site_id is set, use site's address; otherwise fall back to quote address
  let location = q.address || '';
  if (siteId) {
    const site = get('SELECT address,city,state,zip FROM customer_sites WHERE id=?', [siteId]);
    if (site) {
      const siteAddr = [site.address, [site.city, site.state].filter(Boolean).join(', '), site.zip].filter(Boolean).join(', ');
      if (siteAddr) location = siteAddr;
    }
  }
  // Scope — roll up scope_summary and notes
  const scopeBrief = q.scope_summary || '';
  const notes = q.notes || '';
  // Try to match salesperson's department to pre-fill revenue_department
  let revenueDept = '';
  if (q.rep_id) {
    const rep = get('SELECT sales_department FROM users WHERE id=?', [q.rep_id]);
    if (rep && rep.sales_department) revenueDept = rep.sales_department;
  }
  // Default billing type differs by job type
  const billingType = jobType === 'quick_job' ? 'aftermarket' : 'aftermarket';
  // Initial status: quick jobs go to 'awarded' (ready for scheduling as soon as materials OK); projects also 'awarded'
  const initialStatus = 'awarded';
  const projectId = runGetId(`INSERT INTO projects
    (job_number,project_name,customer_id,customer_name,site_id,location,quote_id,quote_number,
     contract_value,billing_type,scope_brief,status,material_status,material_lead_time,material_expected_date,bill_status,start_date,target_end_date,foreman_id,foreman_name,
     assigned_techs,notes,created_by,work_types,required_skills,revenue_department,job_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [q.quote_number||'', projectName, customerId, customerName, siteId, location, q.id, q.quote_number||'',
     contractVal, billingType, scopeBrief, initialStatus, materialStatus, materialLeadTime, materialExpectedDate, 'not_ready', '', '', 0, '',
     '[]', notes, req.session.userId, '[]', '[]', revenueDept, jobType]);

  // Phase 1A.5 — Clone default workflow template tasks into the new project (projects only, not quick_jobs)
  if (jobType === 'project') {
    try { seedWorkflowTasksForProject(projectId, q.rep_id || req.session.userId); } catch(e) { console.error('Workflow seed error:', e); }
  }

  res.json({ ok: true, project_id: projectId, job_type: jobType });
});

// ═══ PHASE 1A.5 — Workflow task helper: clone default template onto a project ═══
// Resolves role-based default assignees to concrete user IDs.
function seedWorkflowTasksForProject(projectId, salesRepId) {
  const proj = get('SELECT foreman_id, start_date FROM projects WHERE id=?', [projectId]);
  if (!proj) return;

  // Find default template
  const tpl = get('SELECT id FROM workflow_templates WHERE is_default=1 AND is_active=1 LIMIT 1');
  if (!tpl) return;

  const tasks = all('SELECT * FROM workflow_template_tasks WHERE template_id=? AND is_active=1 ORDER BY section, sort_order', [tpl.id]);
  if (!tasks.length) return;

  // Build role→user_id map
  const roleMap = {};

  // sales_rep → the rep who won the quote (salesRepId passed in)
  if (salesRepId) {
    const srUser = get('SELECT id, first_name, last_name FROM users WHERE id=?', [salesRepId]);
    if (srUser) roleMap.sales_rep = { id: srUser.id, name: ((srUser.first_name||'') + ' ' + (srUser.last_name||'')).trim() };
  }

  // foreman → projects.foreman_id
  if (proj.foreman_id) {
    const fm = get('SELECT id, first_name, last_name FROM users WHERE id=?', [proj.foreman_id]);
    if (fm) roleMap.foreman = { id: fm.id, name: ((fm.first_name||'') + ' ' + (fm.last_name||'')).trim() };
  }

  // office_manager / project_manager → look up users flagged with workflow_roles JSON containing the role
  ['office_manager','project_manager'].forEach(role => {
    // Naive JSON search: find any user where workflow_roles includes this role string
    const candidate = get(
      `SELECT id, first_name, last_name FROM users WHERE workflow_roles LIKE ? LIMIT 1`,
      [`%"${role}"%`]
    );
    if (candidate) roleMap[role] = { id: candidate.id, name: ((candidate.first_name||'') + ' ' + (candidate.last_name||'')).trim() };
  });

  // Compute a due date from start_date + days_after_start
  function addDays(dateStr, days) {
    if (!dateStr || !days) return '';
    try {
      const d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d.getTime())) return '';
      d.setDate(d.getDate() + parseInt(days, 10));
      return d.toISOString().split('T')[0];
    } catch(e) { return ''; }
  }

  tasks.forEach(t => {
    const resolved = roleMap[t.default_role] || null;
    const dueDate = addDays(proj.start_date, t.default_days_after_start);
    try {
      db.run(`INSERT INTO project_workflow_tasks
        (project_id, section, task_name, description, assigned_user_id, assigned_user_name, default_role, status, due_date, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [projectId, t.section, t.task_name, t.description || '', resolved ? resolved.id : 0,
         resolved ? resolved.name : '', t.default_role || '', dueDate, t.sort_order || 0]);
    } catch(e) { console.error('Task insert error:', e); }
  });
  saveDb();
}

app.delete('/api/quotes/:id', requireAdmin, (req, res) => {
  run('DELETE FROM quotes WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/quotes/:id/duplicate', requireAuth, (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id=?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const u = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const rep_name = u.first_name + (u.last_name ? ' ' + u.last_name : '');
  const id = runGetId(`INSERT INTO quotes (quote_number,rep_id,rep_name,client_name,contact_name,address,email,phone,project_name,scope_summary,scopes,options,notes,subtotal,tax,total,valid_for,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [(q.quote_number||'')+'-COPY', req.session.userId, rep_name, q.client_name, q.contact_name, q.address, q.email, q.phone, (q.project_name||'')+' (Copy)', q.scope_summary, q.scopes, q.options, q.notes, q.subtotal, q.tax, q.total, q.valid_for, 'draft']);
  res.json({ id });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PROJECTS ROUTES ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// List projects
app.get('/api/projects', requireAuth, (req, res) => {
  const { status, search, job_type } = req.query;
  let sql = `SELECT p.*, 
    (SELECT COUNT(*) FROM project_phases WHERE project_id=p.id) as phase_count,
    (SELECT COALESCE(SUM(hours),0) FROM project_hours WHERE project_id=p.id) as total_hours
    FROM projects p WHERE 1=1`;
  const params = [];
  // Phase 1A.2a — filter by job_type; default to 'project' only so existing page stays clean
  const effectiveJobType = job_type || 'project';
  if (effectiveJobType !== 'all') { sql += ' AND (p.job_type=? OR (p.job_type IS NULL AND ?=?))';
    params.push(effectiveJobType, effectiveJobType, 'project');
  }
  if (status) { sql += ' AND p.status=?'; params.push(status); }
  if (search) { sql += ' AND (p.project_name LIKE ? OR p.customer_name LIKE ? OR p.job_number LIKE ?)'; const s='%'+search+'%'; params.push(s,s,s); }
  sql += ' ORDER BY p.updated_at DESC';
  res.json(all(sql, params));
});

// Phase 1A.4a — Project Search (for Invoice Entry job picker)
// MUST be defined BEFORE /api/projects/:id so Express doesn't match "search" as an :id
app.get('/api/projects/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const ql = '%' + q.toLowerCase() + '%';
  const rows = all(`
    SELECT id, job_number, project_name, customer_name, status, job_type,
           billing_model, total_billed_to_date, contract_value
      FROM projects
     WHERE (LOWER(job_number) LIKE ?
            OR LOWER(project_name) LIKE ?
            OR LOWER(customer_name) LIKE ?)
       AND status != 'cancelled'
     ORDER BY
       CASE WHEN LOWER(job_number) = LOWER(?) THEN 0
            WHEN LOWER(job_number) LIKE ? THEN 1
            ELSE 2 END,
       updated_at DESC
     LIMIT 30
  `, [ql, ql, ql, q, q.toLowerCase() + '%']);
  res.json(rows);
});

// Get single project with phases, hours, notes
app.get('/api/projects/:id', requireAuth, (req, res) => {
  const p = get('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({error:'Not found'});
  try { p.assigned_techs = JSON.parse(p.assigned_techs || '[]'); } catch(e) { p.assigned_techs = []; }
  try { p.work_types = JSON.parse(p.work_types || '[]'); if(!Array.isArray(p.work_types)) p.work_types=[]; } catch(e) { p.work_types = []; }
  try { p.required_skills = JSON.parse(p.required_skills || '[]'); if(!Array.isArray(p.required_skills)) p.required_skills=[]; } catch(e) { p.required_skills = []; }
  p.phases = all('SELECT * FROM project_phases WHERE project_id=? ORDER BY sort_order, id', [p.id]);
  p.hours = all(`SELECT ph.*, u.avatar_color FROM project_hours ph 
    LEFT JOIN users u ON u.id=ph.user_id
    WHERE ph.project_id=? ORDER BY ph.work_date DESC, ph.created_at DESC`, [p.id]);
  p.notes = all('SELECT * FROM project_notes WHERE project_id=? ORDER BY created_at DESC', [p.id]);
  p.costs = all('SELECT * FROM project_costs WHERE project_id=? ORDER BY invoice_date DESC, created_at DESC', [p.id]);
  // Phase 1A.5 — include workflow tasks
  p.workflow_tasks = all('SELECT * FROM project_workflow_tasks WHERE project_id=? ORDER BY section, sort_order, id', [p.id]);
  p.total_hours = p.hours.reduce((s,h) => s + (h.hours||0), 0);
  res.json(p);
});

// Create project
app.post('/api/projects', requireAuth, (req, res) => {
  const { job_number, project_name, customer_id, customer_name, site_id, location, quote_id, quote_number,
    contract_value, billing_type, scope_brief, status, start_date, target_end_date, foreman_id, foreman_name,
    assigned_techs, notes, job_type } = req.body;
  if (!project_name) return res.status(400).json({error:'Project name required'});
  const jt = job_type === 'quick_job' ? 'quick_job' : (job_type === 'service' ? 'service' : 'project');
  const id = runGetId(`INSERT INTO projects 
    (job_number,project_name,customer_id,customer_name,site_id,location,quote_id,quote_number,
     contract_value,billing_type,scope_brief,status,start_date,target_end_date,foreman_id,foreman_name,
     assigned_techs,notes,created_by,job_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [job_number||'', project_name, customer_id||0, customer_name||'', site_id||0, location||'',
     quote_id||0, quote_number||'', contract_value||'', billing_type||'aftermarket', scope_brief||'',
     status||'awarded', start_date||'', target_end_date||'', foreman_id||0, foreman_name||'',
     JSON.stringify(assigned_techs||[]), notes||'', req.session.userId, jt]);

  // Phase 1A.5 — Clone workflow template onto the new project (projects only)
  if (jt === 'project') {
    try { seedWorkflowTasksForProject(id, req.session.userId); } catch(e) { console.error('Workflow seed error:', e); }
  }
  res.json({id});
});

// Update project
app.put('/api/projects/:id', requireAuth, (req, res) => {
  const p = get('SELECT id FROM projects WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({error:'Not found'});
  const { job_number, project_name, customer_id, customer_name, site_id, location, quote_id, quote_number,
    contract_value, billing_type, scope_brief, status, start_date, target_end_date, actual_end_date,
    foreman_id, foreman_name, assigned_techs, notes,
    material_status, material_notes, bill_status, bill_notes, invoice_number } = req.body;
  run(`UPDATE projects SET job_number=?,project_name=?,customer_id=?,customer_name=?,site_id=?,location=?,
    quote_id=?,quote_number=?,contract_value=?,billing_type=?,scope_brief=?,status=?,start_date=?,
    target_end_date=?,actual_end_date=?,foreman_id=?,foreman_name=?,assigned_techs=?,notes=?,
    material_status=COALESCE(?,material_status),material_notes=COALESCE(?,material_notes),
    bill_status=COALESCE(?,bill_status),bill_notes=COALESCE(?,bill_notes),invoice_number=COALESCE(?,invoice_number),
    updated_at=datetime('now') WHERE id=?`,
    [job_number||'', project_name, customer_id||0, customer_name||'', site_id||0, location||'',
     quote_id||0, quote_number||'', contract_value||'', billing_type||'aftermarket', scope_brief||'',
     status||'awarded', start_date||'', target_end_date||'', actual_end_date||'', foreman_id||0,
     foreman_name||'', JSON.stringify(assigned_techs||[]), notes||'',
     material_status, material_notes, bill_status, bill_notes, invoice_number,
     req.params.id]);
  res.json({ok:true});
});

app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  run('DELETE FROM projects WHERE id=?', [req.params.id]);
  run('DELETE FROM project_phases WHERE project_id=?', [req.params.id]);
  run('DELETE FROM project_hours WHERE project_id=?', [req.params.id]);
  run('DELETE FROM project_notes WHERE project_id=?', [req.params.id]);
  res.json({ok:true});
});

// Phase 1A.2a — quick status toggle for material / bill status without full record PUT
// Phase 1A.5.1 — when material_status transitions to 'ordered', capture material_order_date
//                 and recalculate material_expected_date from order_date + lead_time midpoint
app.patch('/api/projects/:id/status', requireAuth, (req, res) => {
  const p = get('SELECT id, material_status, material_lead_time, material_order_date FROM projects WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({error:'Not found'});
  const { material_status, material_notes, material_lead_time, material_expected_date, material_order_date, bill_status, bill_notes, invoice_number, status } = req.body;
  const sets = [];
  const params = [];

  // Phase 1A.5.1 — handle ordered transition
  let computedOrderDate = null;
  let computedExpectedDate = null;
  if (material_status !== undefined && material_status === 'ordered' && p.material_status !== 'ordered' && !p.material_order_date && !material_order_date) {
    // First time being marked ordered — capture today as order date
    computedOrderDate = new Date().toISOString().split('T')[0];
    // Recalculate expected date from order_date + lead_time midpoint (use submitted lead_time if present, else existing)
    const effectiveLead = material_lead_time !== undefined ? material_lead_time : p.material_lead_time;
    if (effectiveLead && effectiveLead !== 'custom' && effectiveLead !== '10_plus_weeks') {
      const d = new Date(computedOrderDate + 'T00:00:00');
      if (effectiveLead === 'from_stock')   { /* same day */ }
      else if (effectiveLead === '1_2_weeks')  d.setDate(d.getDate() + 11);
      else if (effectiveLead === '2_4_weeks')  d.setDate(d.getDate() + 21);
      else if (effectiveLead === '4_8_weeks')  d.setDate(d.getDate() + 42);
      else if (effectiveLead === '8_10_weeks') d.setDate(d.getDate() + 63);
      computedExpectedDate = d.toISOString().split('T')[0];
    }
  }

  if (material_status !== undefined) { sets.push('material_status=?'); params.push(material_status); }
  if (material_notes !== undefined)  { sets.push('material_notes=?');  params.push(material_notes); }
  if (material_lead_time !== undefined) { sets.push('material_lead_time=?'); params.push(material_lead_time); }
  // Use submitted expected date if present, else our computed one
  if (material_expected_date !== undefined) { sets.push('material_expected_date=?'); params.push(material_expected_date); }
  else if (computedExpectedDate) { sets.push('material_expected_date=?'); params.push(computedExpectedDate); }
  if (material_order_date !== undefined)    { sets.push('material_order_date=?');    params.push(material_order_date); }
  else if (computedOrderDate)               { sets.push('material_order_date=?');    params.push(computedOrderDate); }
  if (bill_status !== undefined)     { sets.push('bill_status=?');     params.push(bill_status); }
  if (bill_notes !== undefined)      { sets.push('bill_notes=?');      params.push(bill_notes); }
  if (invoice_number !== undefined)  { sets.push('invoice_number=?');  params.push(invoice_number); }
  if (status !== undefined)          { sets.push('status=?');          params.push(status); }
  if (!sets.length) return res.json({ok:true, updated: 0});
  sets.push("updated_at=datetime('now')");
  params.push(req.params.id);
  run(`UPDATE projects SET ${sets.join(',')} WHERE id=?`, params);
  res.json({ok:true, updated: sets.length - 1, computed_order_date: computedOrderDate, computed_expected_date: computedExpectedDate});
});

// ─── PHASES ───────────────────────────────────────────────────────────────────
app.post('/api/projects/:id/phases', requireAuth, (req, res) => {
  const { phase_name, description, status, start_date, end_date, sort_order } = req.body;
  if (!phase_name) return res.status(400).json({error:'Phase name required'});
  const id = runGetId('INSERT INTO project_phases (project_id,phase_name,description,status,start_date,end_date,sort_order) VALUES (?,?,?,?,?,?,?)',
    [req.params.id, phase_name, description||'', status||'pending', start_date||'', end_date||'', sort_order||0]);
  run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [req.params.id]);
  res.json({id});
});

app.put('/api/projects/:id/phases/:pid', requireAuth, (req, res) => {
  const { phase_name, description, status, start_date, end_date, sort_order } = req.body;
  run('UPDATE project_phases SET phase_name=?,description=?,status=?,start_date=?,end_date=?,sort_order=? WHERE id=? AND project_id=?',
    [phase_name, description||'', status||'pending', start_date||'', end_date||'', sort_order||0, req.params.pid, req.params.id]);
  run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [req.params.id]);
  res.json({ok:true});
});

app.delete('/api/projects/:id/phases/:pid', requireAuth, (req, res) => {
  run('DELETE FROM project_phases WHERE id=? AND project_id=?', [req.params.pid, req.params.id]);
  res.json({ok:true});
});

// ─── HOURS ────────────────────────────────────────────────────────────────────
app.get('/api/projects/:id/hours', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM project_hours WHERE project_id=? ORDER BY work_date DESC', [req.params.id]));
});

app.post('/api/projects/:id/hours', requireAuth, (req, res) => {
  const { user_id, user_name, work_date, hours, phase_id, entry_type, timeclock_id, notes } = req.body;
  if (!user_id || !work_date || !hours) return res.status(400).json({error:'user_id, work_date, hours required'});
  const logger = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const loggedBy = logger ? logger.first_name + (logger.last_name?' '+logger.last_name:'') : '';
  const id = runGetId('INSERT INTO project_hours (project_id,phase_id,user_id,user_name,work_date,hours,entry_type,timeclock_id,notes,logged_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, phase_id||0, user_id, user_name, work_date, parseFloat(hours), entry_type||'manual', timeclock_id||0, notes||'', loggedBy]);
  run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [req.params.id]);
  res.json({id});
});

app.delete('/api/projects/:id/hours/:hid', requireAuth, (req, res) => {
  run('DELETE FROM project_hours WHERE id=? AND project_id=?', [req.params.hid, req.params.id]);
  res.json({ok:true});
});

// ─── NOTES ────────────────────────────────────────────────────────────────────
app.post('/api/projects/:id/notes', requireAuth, (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({error:'Note text required'});
  const u = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const author_name = u ? u.first_name + (u.last_name?' '+u.last_name:'') : '';
  const id = runGetId('INSERT INTO project_notes (project_id,author_id,author_name,note) VALUES (?,?,?,?)',
    [req.params.id, req.session.userId, author_name, note]);
  run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [req.params.id]);
  // Phase 1.6 — fire notification to project owner
  try { notifyProjectNoteAdded(req.params.id, note, req.session.userId); } catch(e){}
  res.json({id});
});

app.delete('/api/projects/:id/notes/:nid', requireAuth, (req, res) => {
  run('DELETE FROM project_notes WHERE id=? AND project_id=?', [req.params.nid, req.params.id]);
  res.json({ok:true});
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── JOB COSTING ROUTES ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function generatePoNumber() {
  const settings = getSettings();
  const format = settings.po_format || 'MMYY-###';
  const prefix = settings.po_prefix || '';
  const now = new Date();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yy = String(now.getFullYear()).slice(-2);
  const monthKey = mm + yy;
  // Get/increment sequence
  let seq = get('SELECT last_seq FROM po_sequence WHERE month_key=?', [monthKey]);
  if (!seq) { db.run('INSERT INTO po_sequence (month_key,last_seq) VALUES (?,1)', [monthKey]); saveDb(); seq = {last_seq:1}; }
  else { db.run('UPDATE po_sequence SET last_seq=last_seq+1 WHERE month_key=?', [monthKey]); saveDb(); seq = get('SELECT last_seq FROM po_sequence WHERE month_key=?', [monthKey]); }
  const num = seq.last_seq;
  // Build number from format
  const hashCount = (format.match(/#+/)||['###'])[0].length;
  const numStr = String(num).padStart(hashCount,'0');
  let result = format.replace('MMYY', mm+yy).replace('MM', mm).replace('YY', yy).replace(/#+/, numStr);
  if (prefix) result = prefix + result;
  return result;
}

// Get next PO preview (no increment)
app.get('/api/po/next', requireAuth, (req, res) => {
  const settings = getSettings();
  const format = settings.po_format || 'MMYY-###';
  const prefix = settings.po_prefix || '';
  const now = new Date();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yy = String(now.getFullYear()).slice(-2);
  const monthKey = mm + yy;
  const seq = get('SELECT last_seq FROM po_sequence WHERE month_key=?', [monthKey]);
  const next = (seq ? seq.last_seq : 0) + 1;
  const hashCount = (format.match(/#+/)||['###'])[0].length;
  const numStr = String(next).padStart(hashCount,'0');
  let result = format.replace('MMYY', mm+yy).replace('MM', mm).replace('YY', yy).replace(/#+/, numStr);
  if (prefix) result = prefix + result;
  res.json({ po_number: result });
});

// List costs for a project
app.get('/api/projects/:id/costs', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM project_costs WHERE project_id=? ORDER BY invoice_date DESC, created_at DESC', [req.params.id]));
});

// Add cost entry
app.post('/api/projects/:id/costs', requireAuth, (req, res) => {
  const { category, vendor, description, quantity, unit_cost, total_cost, invoice_number, invoice_date, notes } = req.body;
  if (!description) return res.status(400).json({error:'Description required'});
  const po_number = generatePoNumber();
  const logger = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const loggedBy = logger ? logger.first_name + (logger.last_name?' '+logger.last_name:'') : '';
  const tc = total_cost || ((parseFloat(quantity)||1) * (parseFloat(unit_cost)||0));
  const id = runGetId(`INSERT INTO project_costs (project_id,po_number,category,vendor,description,quantity,unit_cost,total_cost,invoice_number,invoice_date,notes,logged_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.params.id, po_number, category||'materials', vendor||'', description, parseFloat(quantity)||1, parseFloat(unit_cost)||0, parseFloat(tc)||0, invoice_number||'', invoice_date||'', notes||'', loggedBy]);
  run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [req.params.id]);
  // Phase 1A.4a — bump bill vendor's last_used_at so it surfaces first in type-ahead
  if (vendor && vendor.trim()) {
    try {
      const v = get('SELECT id FROM bill_vendors WHERE LOWER(name)=LOWER(?)', [vendor.trim()]);
      if (v) run("UPDATE bill_vendors SET last_used_at=datetime('now') WHERE id=?", [v.id]);
    } catch(e){}
  }
  res.json({id, po_number});
});

// Update cost entry
app.put('/api/projects/:id/costs/:cid', requireAuth, (req, res) => {
  const { category, vendor, description, quantity, unit_cost, total_cost, invoice_number, invoice_date, notes } = req.body;
  const tc = total_cost || ((parseFloat(quantity)||1) * (parseFloat(unit_cost)||0));
  run(`UPDATE project_costs SET category=?,vendor=?,description=?,quantity=?,unit_cost=?,total_cost=?,invoice_number=?,invoice_date=?,notes=? WHERE id=? AND project_id=?`,
    [category||'materials', vendor||'', description, parseFloat(quantity)||1, parseFloat(unit_cost)||0, parseFloat(tc)||0, invoice_number||'', invoice_date||'', notes||'', req.params.cid, req.params.id]);
  run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [req.params.id]);
  res.json({ok:true});
});

app.delete('/api/projects/:id/costs/:cid', requireAuth, (req, res) => {
  run('DELETE FROM project_costs WHERE id=? AND project_id=?', [req.params.cid, req.params.id]);
  res.json({ok:true});
});

// AI invoice extraction
app.post('/api/projects/:id/costs/extract', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({error:'ANTHROPIC_API_KEY not set'});
  const { image_data, media_type, project_name, job_number } = req.body;
  if (!image_data) return res.status(400).json({error:'No image data provided'});
  try {
    const https = require('https');
    const payload = Buffer.from(JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media_type||'image/jpeg', data: image_data } },
          { type: 'text', text: `Extract all line items from this vendor invoice or receipt for a construction project.
Project: ${project_name||'Unknown'}, Job #: ${job_number||'Unknown'}

Return ONLY valid JSON, no markdown, no explanation:
{
  "vendor": "vendor name",
  "invoice_number": "invoice or receipt number if visible",
  "invoice_date": "YYYY-MM-DD format if visible, else empty string",
  "lines": [
    { "description": "item description", "quantity": 1, "unit_cost": 0.00, "total_cost": 0.00, "category": "materials" }
  ]
}
Category must be one of: materials, equipment, subcontractors, labor, other.
If a single lump sum, create one line. Parse all visible line items.` }
        ]
      }]
    }));
    const options = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':payload.length} };
    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const r = JSON.parse(data);
          const text = (r.content||[]).map(c=>c.text||'').join('');
          const clean = text.replace(/```json|```/g,'').trim();
          const parsed = JSON.parse(clean);
          res.json(parsed);
        } catch(e) { res.status(500).json({error:'Could not parse AI response: '+e.message}); }
      });
    });
    apiReq.on('error', e => res.status(500).json({error:e.message}));
    apiReq.write(payload); apiReq.end();
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Update project budgets
app.put('/api/projects/:id/budgets', requireAuth, (req, res) => {
  const { budget_materials, budget_equipment, budget_labor, budget_subs } = req.body;
  run(`UPDATE projects SET budget_materials=?,budget_equipment=?,budget_labor=?,budget_subs=?,updated_at=datetime('now') WHERE id=?`,
    [parseFloat(budget_materials)||0, parseFloat(budget_equipment)||0, parseFloat(budget_labor)||0, parseFloat(budget_subs)||0, req.params.id]);
  res.json({ok:true});
});

// ═══ PHASE 1A — CONSTANTS & ROUTES ════════════════════════════════════════════
const WORK_TYPES = [
  { key: 'overhead_sectional',  label: 'Overhead Sectional' },
  { key: 'rolling_steel',       label: 'Rolling Steel' },
  { key: 'high_speed',          label: 'High Speed' },
  { key: 'specialty_custom',    label: 'Specialty / Custom' },
  { key: 'auto_entry',          label: 'Auto / Entry' },
  { key: 'dock_equipment',      label: 'Dock Equipment' },
  { key: 'operator_electrical', label: 'Operator / Electrical' }
];
const BILL_CATEGORIES = [
  { key: 'material',   label: 'Material' },
  { key: 'freight',    label: 'Freight' },
  { key: 'tax',        label: 'Tax' },
  { key: 'equipment',  label: 'Equipment' },
  { key: 'subs',       label: 'Subcontractors' },
  { key: 'travel',     label: 'Travel / Lodging' },
  { key: 'other',      label: 'Other' }
];
const SKILL_CATEGORIES = [
  { key: 'doors_sectional_coiling',     label: 'Doors — Sectional & Coiling' },
  { key: 'doors_high_speed_specialty',  label: 'Doors — High Speed & Specialty' },
  { key: 'dock_equipment',              label: 'Dock Equipment' },
  { key: 'auto_entry',                  label: 'Auto / Entry' },
  { key: 'operator_electrical',         label: 'Operator / Electrical' },
  { key: 'specialty_structures',        label: 'Specialty Structures' }
];
const REVENUE_DEPARTMENTS = [
  { key: 'auto_entry',        label: 'Auto / Entry Doors' },
  { key: 'new_construction',  label: 'New Construction' },
  { key: 'aftermarket',       label: 'Aftermarket' },
  { key: 'service',           label: 'Service' }
];

// Static lists
app.get('/api/worktypes',      requireAuth, (req,res) => res.json(WORK_TYPES));
app.get('/api/billcategories', requireAuth, (req,res) => res.json(BILL_CATEGORIES));
app.get('/api/skillcategories',requireAuth, (req,res) => res.json(SKILL_CATEGORIES));
app.get('/api/revenuedepts',   requireAuth, (req,res) => res.json(REVENUE_DEPARTMENTS));

// ── Skills master list (admin managed) ──
app.get('/api/skills', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM skills WHERE active=1 ORDER BY category,sort_order,label'));
});
app.post('/api/skills', requireAdmin, (req, res) => {
  const { skill_key, label, category, sort_order } = req.body;
  if (!skill_key || !label) return res.status(400).json({error:'skill_key and label are required'});
  if (get('SELECT id FROM skills WHERE skill_key=?',[skill_key])) return res.status(400).json({error:'skill_key already exists'});
  const id = runGetId(`INSERT INTO skills (skill_key,label,category,sort_order,active) VALUES (?,?,?,?,1)`,
    [skill_key, label, category||'', parseInt(sort_order)||0]);
  res.json({id});
});
app.put('/api/skills/:id', requireAdmin, (req, res) => {
  const { label, category, sort_order, active } = req.body;
  run(`UPDATE skills SET label=?,category=?,sort_order=?,active=? WHERE id=?`,
    [label||'', category||'', parseInt(sort_order)||0, active?1:0, req.params.id]);
  res.json({ok:true});
});
app.delete('/api/skills/:id', requireAdmin, (req, res) => {
  run(`UPDATE skills SET active=0 WHERE id=?`, [req.params.id]);
  res.json({ok:true});
});

// ── User skills / labor rate / sales dept ──
app.get('/api/users/:id/extended', requireManager, (req, res) => {
  const u = get('SELECT id,skills,labor_rate_burdened,labor_rate_updated_at,labor_rate_updated_by_user_id,sales_department FROM users WHERE id=?',[req.params.id]);
  if (!u) return res.status(404).json({error:'User not found'});
  let skills = [];
  try { skills = JSON.parse(u.skills||'[]'); if (!Array.isArray(skills)) skills = []; } catch(e){ skills = []; }
  let updatedByName = '';
  if (u.labor_rate_updated_by_user_id) {
    const up = get('SELECT first_name,last_name FROM users WHERE id=?',[u.labor_rate_updated_by_user_id]);
    if (up) updatedByName = (up.first_name + ' ' + (up.last_name||'')).trim();
  }
  res.json({
    id: u.id,
    skills,
    labor_rate_burdened: u.labor_rate_burdened || 0,
    labor_rate_updated_at: u.labor_rate_updated_at || '',
    labor_rate_updated_by_name: updatedByName,
    sales_department: u.sales_department || ''
  });
});
app.put('/api/users/:id/skills', requireManager, (req, res) => {
  const { skills } = req.body;
  const arr = Array.isArray(skills) ? skills : [];
  run(`UPDATE users SET skills=? WHERE id=?`, [JSON.stringify(arr), req.params.id]);
  res.json({ok:true});
});
app.put('/api/users/:id/labor-rate', requireManager, (req, res) => {
  const { labor_rate_burdened } = req.body;
  const rate = parseFloat(labor_rate_burdened) || 0;
  run(`UPDATE users SET labor_rate_burdened=?,labor_rate_updated_at=datetime('now'),labor_rate_updated_by_user_id=? WHERE id=?`,
    [rate, req.session.userId, req.params.id]);
  res.json({ok:true});
});
app.put('/api/users/:id/sales-dept', requireManager, (req, res) => {
  const { sales_department } = req.body;
  run(`UPDATE users SET sales_department=? WHERE id=?`, [sales_department||'', req.params.id]);
  res.json({ok:true});
});

// ── Project work_types / required_skills / revenue_department ──
app.put('/api/projects/:id/work-meta', requireAuth, (req, res) => {
  const { work_types, required_skills, revenue_department } = req.body;
  const wt = Array.isArray(work_types) ? work_types : [];
  const rs = Array.isArray(required_skills) ? required_skills : [];
  run(`UPDATE projects SET work_types=?,required_skills=?,revenue_department=?,updated_at=datetime('now') WHERE id=?`,
    [JSON.stringify(wt), JSON.stringify(rs), revenue_department||'', req.params.id]);
  res.json({ok:true});
});

// ── Trucks CRUD ──
app.get('/api/trucks', requireAuth, (req, res) => {
  const rows = all(`SELECT t.*, u.first_name AS lead_first_name, u.last_name AS lead_last_name
                    FROM trucks t LEFT JOIN users u ON t.lead_user_id = u.id
                    ORDER BY t.active DESC, t.sort_order, t.id`);
  res.json(rows.map(r => ({
    ...r,
    active: !!r.active,
    lead_name: r.lead_first_name ? (r.lead_first_name + ' ' + (r.lead_last_name||'')).trim() : ''
  })));
});
app.post('/api/trucks', requireManager, (req, res) => {
  const { lead_user_id, sort_order, row_type, notes, temp_start_date, temp_end_date } = req.body;
  const id = runGetId(`INSERT INTO trucks (lead_user_id,sort_order,row_type,notes,temp_start_date,temp_end_date,active)
                       VALUES (?,?,?,?,?,?,1)`,
    [parseInt(lead_user_id)||0, parseInt(sort_order)||0, row_type||'truck', notes||'', temp_start_date||'', temp_end_date||'']);
  res.json({id});
});
app.put('/api/trucks/:id', requireManager, (req, res) => {
  const { lead_user_id, sort_order, row_type, notes, temp_start_date, temp_end_date, active } = req.body;
  run(`UPDATE trucks SET lead_user_id=?,sort_order=?,row_type=?,notes=?,temp_start_date=?,temp_end_date=?,active=? WHERE id=?`,
    [parseInt(lead_user_id)||0, parseInt(sort_order)||0, row_type||'truck', notes||'',
     temp_start_date||'', temp_end_date||'', active?1:0, req.params.id]);
  res.json({ok:true});
});
app.delete('/api/trucks/:id', requireAdmin, (req, res) => {
  run(`UPDATE trucks SET active=0 WHERE id=?`, [req.params.id]);
  res.json({ok:true});
});

// ── Default GL accounts per bill category (settings pass-through) ──
app.put('/api/gl-defaults', requireAdmin, (req, res) => {
  const map = req.body || {};
  Object.keys(map).forEach(cat => {
    const k = 'gl_default_' + cat;
    run(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(map[cat]||'')]);
  });
  res.json({ok:true});
});
app.get('/api/gl-defaults', requireAuth, (req, res) => {
  const out = {};
  BILL_CATEGORIES.forEach(c => {
    const row = get(`SELECT value FROM settings WHERE key=?`, ['gl_default_' + c.key]);
    out[c.key] = row ? (row.value || '') : '';
  });
  res.json(out);
});

// ── Chart of Accounts (admin maintained) ──
app.get('/api/chart-of-accounts', requireAuth, (req, res) => {
  res.json(all(`SELECT * FROM chart_of_accounts WHERE active=1 ORDER BY sort_order,account_number,account_name`));
});
app.post('/api/chart-of-accounts', requireAdmin, (req, res) => {
  const { account_number, account_name, account_type, sort_order } = req.body;
  if (!account_name) return res.status(400).json({error:'account_name is required'});
  const id = runGetId(`INSERT INTO chart_of_accounts (account_number,account_name,account_type,sort_order,active)
                       VALUES (?,?,?,?,1)`,
    [account_number||'', account_name, account_type||'', parseInt(sort_order)||0]);
  res.json({id});
});
app.put('/api/chart-of-accounts/:id', requireAdmin, (req, res) => {
  const { account_number, account_name, account_type, sort_order, active } = req.body;
  run(`UPDATE chart_of_accounts SET account_number=?,account_name=?,account_type=?,sort_order=?,active=? WHERE id=?`,
    [account_number||'', account_name||'', account_type||'', parseInt(sort_order)||0, active?1:0, req.params.id]);
  res.json({ok:true});
});
app.delete('/api/chart-of-accounts/:id', requireAdmin, (req, res) => {
  run(`UPDATE chart_of_accounts SET active=0 WHERE id=?`, [req.params.id]);
  res.json({ok:true});
});

// ── Database backup download (admin only) ──
app.get('/api/admin/db-backup', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(DB_PATH)) return res.status(404).json({error:'Database file not found'});
    saveDb(); // ensure latest
    const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Disposition','attachment; filename="kvm-db-backup-'+stamp+'.db"');
    fs.createReadStream(DB_PATH).pipe(res);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ═══ END PHASE 1A ═════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.1.1 — ATOMIC JOB NUMBER COUNTER (shared quotes + service calls) ═
// ═══════════════════════════════════════════════════════════════════════════════

// Build MMYY key for a given Date (or now)
function currentMonthKey() {
  const d = new Date();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = String(d.getFullYear()).slice(-2);
  return mm + yy;
}

// Atomic next-number: sql.js is single-threaded at the Node.js event loop level,
// so this SELECT-then-UPDATE cannot be raced by another request on the same instance.
function allocateNextJobNumber() {
  const key = currentMonthKey();
  let row = get('SELECT last_seq FROM job_sequence WHERE month_key=?', [key]);
  let next;
  if (!row) {
    next = 1;
    db.run(`INSERT INTO job_sequence (month_key, last_seq, updated_at) VALUES (?, ?, datetime('now'))`, [key, next]);
  } else {
    next = (row.last_seq || 0) + 1;
    db.run(`UPDATE job_sequence SET last_seq=?, updated_at=datetime('now') WHERE month_key=?`, [next, key]);
  }
  saveDb();
  return `${key}-${next}`;
}

// Preview the next number without allocating (for UI display hints)
app.get('/api/job-number/peek', requireAuth, (req, res) => {
  const key = currentMonthKey();
  const row = get('SELECT last_seq FROM job_sequence WHERE month_key=?', [key]);
  const next = (row ? row.last_seq||0 : 0) + 1;
  res.json({ next_number: `${key}-${next}`, month_key: key });
});

// Allocate and return the next number (increments the counter — use only when
// the caller commits to using this number)
app.post('/api/job-number/next', requireAuth, (req, res) => {
  try {
    const num = allocateNextJobNumber();
    res.json({ job_number: num });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.1.2 — TEST DATA SEED / PURGE ═══════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/test-data/status', requireAdmin, (req, res) => {
  try {
    const counts = {};
    ['customers','customer_sites','customer_contacts','quotes','projects','project_costs','project_phases','project_notes','project_hours']
      .forEach(t => {
        try { const r = get(`SELECT COUNT(*) AS c FROM ${t} WHERE is_test_data=1`); counts[t] = r ? r.c : 0; }
        catch(e) { counts[t] = 0; }
      });
    const total = Object.values(counts).reduce((a,b)=>a+b,0);
    res.json({ total, counts, has_test_data: total > 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test-data/seed', requireAdmin, (req, res) => {
  try {
    // Guard: don't double-seed
    const existing = get('SELECT COUNT(*) AS c FROM customers WHERE is_test_data=1');
    if (existing && existing.c > 0) {
      return res.status(400).json({ error: 'Test data already seeded. Purge first if you want to re-seed.' });
    }

    // Pick a salesperson user for attribution (any non-global-admin user, or admin if none)
    const salesUser = get("SELECT id,first_name,last_name FROM users WHERE role_type IN ('sales','manager','admin') AND username != 'admin' LIMIT 1")
                  || get("SELECT id,first_name,last_name FROM users WHERE id=?", [req.session.userId])
                  || { id: 1, first_name: 'Admin', last_name: '' };
    const salesName = (salesUser.first_name + ' ' + (salesUser.last_name||'')).trim();

    // ── CUSTOMERS ──────────────────────────────────────────
    const customerSeed = [
      // [company_name, type, phone, email, addr, city, state, zip, terms, union, partner, notes]
      ['(TEST) ABC Builders Inc', 'General Contractor', '(248) 555-1001', 'pm@abcbuilders-test.com',
       '12450 Industrial Dr', 'Troy', 'MI', '48083', 'Net 30 Days', 1, 0, 'Test GC — union required'],
      ['(TEST) Detroit Property Group', 'Property Manager', '(313) 555-2100', 'ops@dpg-test.com',
       '500 Woodward Ave', 'Detroit', 'MI', '48226', 'Net 30 Days', 0, 0, 'Test property manager w/ multiple sites'],
      ['(TEST) Great Lakes Construction', 'General Contractor', '(248) 555-3200', 'bids@glc-test.com',
       '28000 N Campbell Rd', 'Madison Heights', 'MI', '48071', 'Net 45 days', 0, 0, 'Test GC'],
      ['(TEST) Metro Industrial Park', 'Industrial', '(586) 555-4100', 'facilities@mip-test.com',
       '42100 Vans Ave', 'Warren', 'MI', '48089', 'Net 30', 0, 0, 'Test industrial end-user'],
      ['(TEST) Paslin Manufacturing', 'Industrial', '(248) 555-5200', 'maint@paslin-test.com',
       '25001 Dequindre Rd', 'Madison Heights', 'MI', '48071', 'Net 30', 0, 0, 'Test — matches quote example'],
      ['(TEST) Suburban Retail Holdings', 'Retail', '(248) 555-6300', 'ops@srh-test.com',
       '2800 Livernois Rd', 'Troy', 'MI', '48083', 'Net 30 Days', 0, 0, 'Test retail chain — 8 locations'],
      ['(TEST) DH Pace Test Partner', 'Partner Door Company', '(816) 555-7001', 'workorders@dhpace-test.com',
       '1901 E 119th St', 'Olathe', 'KS', '66061', 'Net 45 days', 0, 1, 'Test partner door company'],
      ['(TEST) Corewell Health System', 'End User / Building Owner', '(616) 555-8100', 'facilities@corewell-test.com',
       '100 Michigan NE', 'Grand Rapids', 'MI', '49503', 'Net 30 Days', 0, 0, 'Test large end-user w/ multiple sites'],
      ['(TEST) Kroger Supermarket Division', 'Retail', '(513) 555-9100', 'mw-facilities@kroger-test.com',
       '1014 Vine St', 'Cincinnati', 'OH', '45202', 'Net 30 Days', 0, 0, 'Test retail w/ many stores'],
      ['(TEST) Quick Fix LLC', 'End User / Building Owner', '(248) 555-0102', 'steve@quickfix-test.com',
       '301 Main St', 'Rochester', 'MI', '48307', 'Due on receipt', 0, 0, 'Test one-off small customer'],
      ['(TEST) Aristeo Construction', 'General Contractor', '(313) 555-1212', 'bids@aristeo-test.com',
       '12811 Farmington Rd', 'Livonia', 'MI', '48150', 'Net 30 Days', 1, 0, 'Test GC — union'],
      ['(TEST) Five Lakes Cold Storage', 'Industrial', '(810) 555-1313', 'plant@flcs-test.com',
       '4140 Lapeer Rd', 'Port Huron', 'MI', '48060', 'Net 30 Days', 0, 0, 'Test industrial freezer facility'],
      ['(TEST) Oakland County School District', 'Municipality / Government', '(248) 555-1414', 'fac@ocsd-test.gov',
       '2100 Pontiac Lake Rd', 'Waterford', 'MI', '48328', 'Net 30 Days', 1, 0, 'Test municipal — tax exempt'],
      ['(TEST) Home Depot Service Request', 'Retail', '(770) 555-1515', 'srs@homedepot-test.com',
       '2455 Paces Ferry Rd NW', 'Atlanta', 'GA', '30339', 'Net 30 Days', 0, 0, 'Test big box retail'],
      ['(TEST) Walmart Facility Mgmt', 'Retail', '(479) 555-1616', 'fm@walmart-test.com',
       '702 SW 8th St', 'Bentonville', 'AR', '72716', 'Net 30 Days', 0, 0, 'Test big box retail'],
    ];
    const customerIds = {};
    customerSeed.forEach(c => {
      const id = runGetId(`INSERT INTO customers 
        (company_name,customer_type,billing_phone,billing_email,billing_address,billing_city,billing_state,billing_zip,
         credit_terms,union_required,is_partner_company,tax_exempt,internal_notes,status,assigned_salesperson_id,is_test_data)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[1] === 'Municipality / Government' ? 1 : 0, c[11], 'active', salesUser.id]);
      customerIds[c[0]] = id;
    });

    // ── CUSTOMER_SITES (multi-site customers get several) ──
    const siteSeed = [
      // [company_name, site_name, store_number, addr, city, state, zip]
      ['(TEST) Detroit Property Group', 'Downtown Office Tower', '', '500 Woodward Ave', 'Detroit', 'MI', '48226'],
      ['(TEST) Detroit Property Group', 'Westside Industrial Park', '', '8200 W Warren Ave', 'Detroit', 'MI', '48210'],
      ['(TEST) Detroit Property Group', 'Northland Business Center', '', '21000 Greenfield Rd', 'Oak Park', 'MI', '48237'],
      ['(TEST) Detroit Property Group', 'Troy Commerce Park', '', '3400 Stephenson Hwy', 'Troy', 'MI', '48083'],
      ['(TEST) Detroit Property Group', 'Southfield Tower', '', '26555 Evergreen Rd', 'Southfield', 'MI', '48076'],
      ['(TEST) Suburban Retail Holdings', 'Store #101 — Troy', '101', '400 W Big Beaver Rd', 'Troy', 'MI', '48084'],
      ['(TEST) Suburban Retail Holdings', 'Store #102 — Novi', '102', '27500 Novi Rd', 'Novi', 'MI', '48377'],
      ['(TEST) Suburban Retail Holdings', 'Store #103 — Sterling Hts', '103', '36500 Van Dyke Ave', 'Sterling Heights', 'MI', '48312'],
      ['(TEST) Suburban Retail Holdings', 'Store #104 — Ann Arbor', '104', '3655 Washtenaw Ave', 'Ann Arbor', 'MI', '48104'],
      ['(TEST) Corewell Health System', 'Beaumont Hospital — Royal Oak', '', '3601 W 13 Mile Rd', 'Royal Oak', 'MI', '48073'],
      ['(TEST) Corewell Health System', 'Beaumont Hospital — Farmington', '', '28050 Grand River Ave', 'Farmington Hills', 'MI', '48336'],
      ['(TEST) Corewell Health System', 'Corewell Dearborn', '', '18101 Oakwood Blvd', 'Dearborn', 'MI', '48124'],
      ['(TEST) Kroger Supermarket Division', 'Kroger #656 — Warren', '656', '27460 Van Dyke Ave', 'Warren', 'MI', '48093'],
      ['(TEST) Kroger Supermarket Division', 'Kroger #729 — Sterling Heights', '729', '44475 Schoenherr Rd', 'Sterling Heights', 'MI', '48313'],
      ['(TEST) Home Depot Service Request', 'Home Depot #2810 — Madison Hts', '2810', '32525 John R Rd', 'Madison Heights', 'MI', '48071'],
      ['(TEST) Walmart Facility Mgmt', 'Walmart SuperCenter #2692 — Taylor', '2692', '7000 Telegraph Rd', 'Taylor', 'MI', '48180'],
      ['(TEST) Walmart Facility Mgmt', 'Walmart #1611 — Sterling Heights', '1611', '33201 Van Dyke Ave', 'Sterling Heights', 'MI', '48312'],
    ];
    siteSeed.forEach(s => {
      const cid = customerIds[s[0]]; if (!cid) return;
      runGetId(`INSERT INTO customer_sites
        (customer_id,site_name,store_number,address,city,state,zip,status,is_test_data)
        VALUES (?,?,?,?,?,?,?,'active',1)`,
        [cid, s[1], s[2], s[3], s[4], s[5], s[6]]);
    });

    // ── CUSTOMER_CONTACTS (primary contacts — all 15 customers) ──
    const contactSeed = [
      // [company_key, first, last, title, phone, email]
      ['(TEST) ABC Builders Inc', 'Bob', 'Johnson', 'Project Manager', '(248) 555-1001', 'bob@abcbuilders-test.com'],
      ['(TEST) Detroit Property Group', 'Sarah', 'Chen', 'Facilities Director', '(313) 555-2100', 'sarah@dpg-test.com'],
      ['(TEST) Great Lakes Construction', 'Mike', 'Sullivan', 'Estimator', '(248) 555-3200', 'mike@glc-test.com'],
      ['(TEST) Metro Industrial Park', 'Karen', 'Black', 'Facilities Manager', '(586) 555-4100', 'karen@mip-test.com'],
      ['(TEST) Paslin Manufacturing', 'Tom', 'Reilly', 'Maintenance Lead', '(248) 555-5200', 'tom@paslin-test.com'],
      ['(TEST) Suburban Retail Holdings', 'Rachel', 'Green', 'Regional Ops Mgr', '(248) 555-6300', 'rachel@srh-test.com'],
      ['(TEST) DH Pace Test Partner', 'Chris', 'Kowalski', 'Subcontractor Coord', '(816) 555-7001', 'chris@dhpace-test.com'],
      ['(TEST) Corewell Health System', 'Jennifer', 'Martinez', 'Facilities Coordinator', '(616) 555-8100', 'jennifer@corewell-test.com'],
      ['(TEST) Kroger Supermarket Division', 'Dan', 'Reeves', 'Midwest Facilities', '(513) 555-9100', 'dan@kroger-test.com'],
      ['(TEST) Quick Fix LLC', 'Steve', 'Park', 'Owner', '(248) 555-0102', 'steve@quickfix-test.com'],
      ['(TEST) Aristeo Construction', 'Dave', 'Moretti', 'Superintendent', '(313) 555-1212', 'dave@aristeo-test.com'],
      ['(TEST) Five Lakes Cold Storage', 'Jim', 'Caldwell', 'Plant Manager', '(810) 555-1313', 'jim@flcs-test.com'],
      ['(TEST) Oakland County School District', 'Linda', 'Park', 'Building Services', '(248) 555-1414', 'linda@ocsd-test.gov'],
      ['(TEST) Home Depot Service Request', 'Marcus', 'Webb', 'Facilities Coord', '(770) 555-1515', 'marcus@homedepot-test.com'],
      ['(TEST) Walmart Facility Mgmt', 'Teresa', 'Nguyen', 'Midwest Facilities', '(479) 555-1616', 'teresa@walmart-test.com'],
    ];
    contactSeed.forEach(c => {
      const cid = customerIds[c[0]]; if (!cid) return;
      db.run(`INSERT INTO customer_contacts
        (customer_id,site_id,first_name,last_name,title,phone,email,is_primary,is_test_data)
        VALUES (?,0,?,?,?,?,?,1,1)`,
        [cid, c[1], c[2], c[3], c[4], c[5]]);
    });
    saveDb();

    // ── QUOTES (varied statuses + REAL scope line items) ──
    // scope format: array of { title, lines: [{ desc, price }] }
    const quoteSeed = [
      {
        customerKey: '(TEST) Paslin Manufacturing',
        projectName: 'Paslin — 4 Sectional Doors + Controls',
        scopeSummary: '4 20\'x20\' sectional doors with low voltage control wiring and motors',
        status: 'draft',
        scopes: [
          { title: 'Shipping Bay Doors (4 ea.)', lines: [
            { desc: '20\'x20\' sectional doors, insulated, white', price: '92000' },
            { desc: 'LiftMaster commercial operators (4)', price: '18000' },
            { desc: 'Motor and track hardware, all openings', price: '12000' },
          ]},
          { title: 'Controls & Low-Voltage Wiring', lines: [
            { desc: 'Safety edges, photo eyes, pull stations', price: '8500' },
            { desc: 'Low voltage wiring + conduit runs', price: '11500' },
          ]},
          { title: 'Labor & Installation', lines: [
            { desc: 'Removal of existing doors, install new', price: '8000' },
          ]},
        ],
        total: '150000',
      },
      {
        customerKey: '(TEST) ABC Builders Inc',
        projectName: 'ABC — New Construction Door Package',
        scopeSummary: 'New construction door package for Bldg C — 12 overhead, 2 auto entry',
        status: 'sent',
        scopes: [
          { title: 'Dock Doors (8 ea.)', lines: [
            { desc: '9\'x10\' insulated sectional, w/ operators', price: '112000' },
          ]},
          { title: 'Drive-Thru Doors (4 ea.)', lines: [
            { desc: '12\'x14\' high-speed Rytec FastSeal', price: '88000' },
          ]},
          { title: 'Auto Entry (2 ea.)', lines: [
            { desc: 'Stanley Dura-Glide SL automatic sliding', price: '32000' },
          ]},
          { title: 'Installation & Commissioning', lines: [
            { desc: 'Install all openings, test, punch', price: '38000' },
            { desc: 'Coordination w/ GC, site mgmt', price: '15000' },
          ]},
        ],
        total: '285000',
      },
      {
        customerKey: '(TEST) Quick Fix LLC',
        projectName: 'Quick Fix — Spring Replacement',
        scopeSummary: 'Replace broken torsion spring, service adjustment',
        status: 'accepted',
        scopes: [
          { title: 'Spring Replacement', lines: [
            { desc: 'Torsion spring (1 ea.)', price: '185' },
            { desc: 'Labor — replace spring, adjust tension', price: '250' },
            { desc: 'Service call fee', price: '50' },
          ]},
        ],
        total: '485',
      },
      {
        customerKey: '(TEST) Kroger Supermarket Division',
        projectName: 'Kroger #656 — Dock Leveler Repair',
        scopeSummary: 'Repair hydraulic pump and seal on dock leveler #3',
        status: 'sent',
        scopes: [
          { title: 'Dock Leveler #3 Repair', lines: [
            { desc: 'Replace hydraulic pump assembly', price: '1450' },
            { desc: 'Replace pit seals and bumpers', price: '650' },
            { desc: 'Labor (8 hrs, 2 techs)', price: '750' },
          ]},
        ],
        total: '2850',
      },
      {
        customerKey: '(TEST) Suburban Retail Holdings',
        projectName: 'Store 101 — Entry Door Replacement',
        scopeSummary: 'Replace front entry auto door assembly (Stanley)',
        status: 'accepted',
        scopes: [
          { title: 'Stanley Auto Door — Front Entry', lines: [
            { desc: 'Stanley Dura-Glide SL-50 complete assembly', price: '5800' },
            { desc: 'Removal of existing door', price: '450' },
            { desc: 'Install, tune, commission', price: '1650' },
          ]},
        ],
        total: '7900',
      },
      {
        customerKey: '(TEST) Corewell Health System',
        projectName: 'Beaumont Royal Oak — Fire Door PM',
        scopeSummary: 'Annual drop test + maintenance on 14 fire doors',
        status: 'declined',
        scopes: [
          { title: 'Annual Fire Door Inspection', lines: [
            { desc: 'Drop test + inspection, 14 doors', price: '2800' },
            { desc: 'NFPA 80 compliance documentation', price: '500' },
            { desc: 'Minor adjustments + lubrication', price: '900' },
          ]},
        ],
        total: '4200',
      },
      {
        customerKey: '(TEST) Metro Industrial Park',
        projectName: 'MIP — High Speed Door Install',
        scopeSummary: 'Install new Rytec high-speed door at shipping bay',
        status: 'draft',
        scopes: [
          { title: 'Rytec Predator 14\' Installation', lines: [
            { desc: 'Rytec Predator 14\'x14\', insulated', price: '14500' },
            { desc: 'Activation package — motion + push buttons', price: '2200' },
            { desc: 'Removal of existing door', price: '1200' },
            { desc: 'Labor — install, wire, commission', price: '3800' },
            { desc: 'Freight to site', price: '800' },
          ]},
        ],
        total: '22500',
      },
    ];
    const quoteIds = {};
    quoteSeed.forEach((q, idx) => {
      const cid = customerIds[q.customerKey]; if (!cid) return;
      // Get primary contact name if available
      const pc = get('SELECT first_name,last_name,phone,email FROM customer_contacts WHERE customer_id=? AND is_primary=1 LIMIT 1', [cid]);
      const contactName = pc ? ((pc.first_name||'') + ' ' + (pc.last_name||'')).trim() : '';
      const cust = get('SELECT billing_phone,billing_email,billing_address,billing_city,billing_state,billing_zip FROM customers WHERE id=?', [cid]);
      const addr = cust ? [cust.billing_address, [cust.billing_city, cust.billing_state].filter(Boolean).join(', '), cust.billing_zip].filter(Boolean).join(', ') : '';
      // Compute subtotal + tax from total
      const totalNum = parseFloat(q.total) || 0;
      const subtotal = (totalNum / 1.06).toFixed(2);
      const tax = (totalNum - parseFloat(subtotal)).toFixed(2);
      const id = runGetId(`INSERT INTO quotes
        (quote_number,rep_id,rep_name,customer_id,client_name,contact_name,address,phone,email,
         project_name,scope_summary,scopes,options,notes,subtotal,tax,total,valid_for,status,is_test_data)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        ['', salesUser.id, salesName, cid, q.customerKey, contactName, addr,
         cust ? cust.billing_phone : '', cust ? cust.billing_email : '',
         q.projectName, q.scopeSummary,
         JSON.stringify(q.scopes || []), '[]',
         'Test seeded quote with realistic scope line items.',
         subtotal, tax, q.total,
         '30 days', q.status]);
      quoteIds[idx] = id;
    });

    // ── PROJECTS (varied statuses, with budgets) ──
    const projectSeed = [
      {
        customerKey: '(TEST) Quick Fix LLC',
        projectName: 'Quick Fix — Spring Replacement',
        contractValue: '485',
        billingType: 'aftermarket',
        status: 'scheduled',
        scope: 'Replace broken torsion spring on residential-style sectional door at commercial facility. Service adjustment to rebalance and inspect rollers.',
        budgets: { mat: 185, equip: 0, labor: 200, subs: 0 },
        seedPhases: [
          ['Parts Ordered', 'Spring on hand from shop stock', 'complete', 1],
          ['Site Visit & Repair', 'Tech on site, replace spring, test', 'pending', 2],
        ],
        seedCosts: [], // too small to itemize
        seedHours: [],
        seedNotes: [['Customer called Tuesday — broken spring, facility manager Steve. Tech dispatched Thursday morning.']],
      },
      {
        customerKey: '(TEST) Suburban Retail Holdings',
        projectName: 'Store 101 — Entry Door Replacement',
        contractValue: '7900',
        billingType: 'aftermarket',
        status: 'in_progress',
        scope: 'Replace complete Stanley Dura-Glide SL-50 auto door assembly at front entry. Remove existing, install new, commission and train staff.',
        budgets: { mat: 4200, equip: 200, labor: 2400, subs: 0 },
        seedPhases: [
          ['Material Ordered', 'Stanley door ordered, 10-day lead time', 'complete', 1],
          ['Material Received', 'Door arrived at shop', 'complete', 2],
          ['Installation', 'Remove existing + install new at store', 'in_progress', 3],
          ['Commissioning & Training', 'Tune door, train store manager', 'pending', 4],
        ],
        seedCosts: [
          ['materials','Stanley Access','Stanley Dura-Glide SL-50 complete assy','1','3850','3850','INV-10055'],
          ['materials','Stanley Access','Weather stripping & threshold kit','1','285','285','INV-10055'],
          ['equipment','United Rentals','Scissor lift rental — 2 days','2','175','350','UR-88721'],
          ['labor','KVM Internal','Tech labor — remove existing (Mike R, 4 hrs)','4','65','260',''],
          ['labor','KVM Internal','Tech labor — install new (Kevin B + Mike R, 6 hrs ea)','12','65','780',''],
        ],
        seedHours: [
          ['Mike R','2026-04-14',4,'Removed existing Stanley auto door'],
          ['Kevin B','2026-04-15',6,'New door install — frame setup'],
          ['Mike R','2026-04-15',6,'New door install — hardware + operator'],
        ],
        seedNotes: [
          ['Awarded 3/28. Material ordered same day, arrived 4/8. Scheduled install 4/14-4/15.'],
          ['Existing door removed clean — no frame damage. Install went smoothly.'],
          ['Final commissioning + staff training scheduled for 4/19.'],
        ],
      },
      {
        customerKey: '(TEST) ABC Builders Inc',
        projectName: 'ABC — Bldg C Door Package (Prior Year)',
        contractValue: '285000',
        billingType: 'new_construction_monthly',
        status: 'complete',
        scope: 'New construction door package for Building C — 8 dock doors, 4 Rytec high-speed doors, 2 Stanley auto entries. Full install and commissioning.',
        budgets: { mat: 188000, equip: 12000, labor: 58000, subs: 9000 },
        seedPhases: [
          ['Shop Drawings', 'Submit drawings for GC approval', 'complete', 1],
          ['Material Order', 'Factory orders placed', 'complete', 2],
          ['Delivery Staging', 'Material received + staged at site', 'complete', 3],
          ['Install — Dock Doors', '8 sectional installs', 'complete', 4],
          ['Install — Rytec', '4 high-speed installs', 'complete', 5],
          ['Install — Auto Entry', 'Stanley installs', 'complete', 6],
          ['Punch List & Close Out', 'Owner walkthrough + corrections', 'complete', 7],
        ],
        seedCosts: [
          ['materials','Overhead Door Corp','8 sectional doors w/ operators','8','14000','112000','OH-22980'],
          ['materials','Rytec','4 FastSeal high-speed doors','4','22000','88000','RYT-11287'],
          ['materials','Stanley Access','2 Dura-Glide SL auto entries','2','16000','32000','STA-55120'],
          ['equipment','Sunbelt Rentals','Reach lift rental — 3 weeks','21','285','5985','SB-55001'],
          ['equipment','United Rentals','Scissor lift — 2 weeks','14','175','2450','UR-88831'],
          ['labor','KVM Internal','Crew labor — install weeks 1-3','240','65','15600',''],
          ['labor','KVM Internal','Crew labor — commissioning + punch','80','65','5200',''],
          ['subs','Acme Electrical','Low voltage runs for operators','1','7800','7800','ACE-3391'],
        ],
        seedHours: [
          ['Kevin B','2026-02-10',8,'Shop drawings submitted to GC'],
          ['Kevin B','2026-03-02',10,'Dock doors install — day 1'],
          ['Mike R','2026-03-02',10,'Dock doors install — day 1'],
          ['Kevin B','2026-03-03',10,'Dock doors install — day 2'],
          ['Mike R','2026-03-03',10,'Dock doors install — day 2'],
          ['Skyler W','2026-03-09',8,'Rytec high-speed install — start'],
        ],
        seedNotes: [
          ['Project kicked off January 2026 with ABC Builders — large new construction.'],
          ['Shop drawings approved by GC 2/14.'],
          ['All material delivered to site by end of February, on schedule.'],
          ['Punch list complete 4/5/26 — final invoice sent.'],
        ],
      },
    ];
    projectSeed.forEach(p => {
      const cid = customerIds[p.customerKey]; if (!cid) return;
      const pid = runGetId(`INSERT INTO projects
        (job_number,project_name,customer_id,customer_name,contract_value,billing_type,scope_brief,status,
         created_by,work_types,required_skills,revenue_department,job_type,is_test_data,
         budget_materials,budget_equipment,budget_labor,budget_subs)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
        ['', p.projectName, cid, p.customerKey, p.contractValue, p.billingType, p.scope, p.status,
         salesUser.id, '[]', '[]', 'aftermarket', 'project',
         p.budgets.mat, p.budgets.equip, p.budgets.labor, p.budgets.subs]);

      // Phases
      (p.seedPhases || []).forEach(ph => {
        db.run(`INSERT INTO project_phases
          (project_id,phase_name,description,status,sort_order,is_test_data)
          VALUES (?,?,?,?,?,1)`,
          [pid, ph[0], ph[1], ph[2], ph[3]]);
      });

      // Costs
      (p.seedCosts || []).forEach(c => {
        db.run(`INSERT INTO project_costs
          (project_id,po_number,category,vendor,description,quantity,unit_cost,total_cost,invoice_number,logged_by,is_test_data)
          VALUES (?,'',?,?,?,?,?,?,?,?,1)`,
          [pid, c[0], c[1], c[2], parseFloat(c[3]), parseFloat(c[4]), parseFloat(c[5]), c[6], salesName]);
      });

      // Hours
      (p.seedHours || []).forEach(h => {
        db.run(`INSERT INTO project_hours
          (project_id,user_id,user_name,work_date,hours,entry_type,notes,logged_by,is_test_data)
          VALUES (?,?,?,?,?,'manual',?,?,1)`,
          [pid, salesUser.id, h[0], h[1], h[2], h[3], salesName]);
      });

      // Notes
      (p.seedNotes || []).forEach(n => {
        db.run(`INSERT INTO project_notes
          (project_id,author_id,author_name,note,is_test_data)
          VALUES (?,?,?,?,1)`,
          [pid, salesUser.id, salesName, n[0]]);
      });
    });
    saveDb();

    // Final counts
    const counts = {};
    ['customers','customer_sites','customer_contacts','quotes','projects','project_phases','project_costs','project_hours','project_notes']
      .forEach(t => { try { const r = get(`SELECT COUNT(*) AS c FROM ${t} WHERE is_test_data=1`); counts[t] = r ? r.c : 0; } catch(e) { counts[t] = 0; } });

    res.json({ ok: true, seeded: counts });
  } catch(e) {
    console.error('Test seed error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test-data/purge', requireAdmin, (req, res) => {
  try {
    const tables = ['project_costs','project_hours','project_notes','project_phases','projects',
                    'quotes','customer_contacts','customer_equipment','customer_sites','customers'];
    const deleted = {};
    tables.forEach(t => {
      try {
        const before = get(`SELECT COUNT(*) AS c FROM ${t} WHERE is_test_data=1`);
        const n = before ? before.c : 0;
        if (n > 0) db.run(`DELETE FROM ${t} WHERE is_test_data=1`);
        deleted[t] = n;
      } catch(e) { deleted[t] = 0; }
    });
    saveDb();
    res.json({ ok: true, deleted });
  } catch(e) {
    console.error('Test purge error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.2b — UNIFIED SEARCH (customers + sites + jobs) ═════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/search?q=kroger+56 — returns mixed results: sites + customers + jobs
app.get('/api/search', requireAuth, (req, res) => {
  const raw = (req.query.q || '').trim();
  const types = (req.query.types || 'customer,site,job').split(',').map(t => t.trim());
  if (!raw) return res.json({ query: '', results: [] });
  const q = '%' + raw.toLowerCase() + '%';
  const results = [];

  // SITES — joined to customers for context
  if (types.includes('site')) {
    const sites = all(`
      SELECT s.id AS site_id, s.site_name, s.store_number, s.address AS site_address,
             s.city AS site_city, s.state AS site_state, s.zip AS site_zip,
             s.customer_id, c.company_name, c.billing_phone, c.billing_email,
             c.is_test_data AS cust_is_test
      FROM customer_sites s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE (s.status IS NULL OR s.status = 'active' OR s.status = '')
      AND (
        LOWER(s.site_name) LIKE ? OR LOWER(s.address) LIKE ? OR LOWER(s.city) LIKE ?
        OR LOWER(s.store_number) LIKE ? OR LOWER(c.company_name) LIKE ?
      )
      LIMIT 15`, [q, q, q, q, q]);
    sites.forEach(s => {
      const addr = [s.site_address, [s.site_city, s.site_state].filter(Boolean).join(', '), s.site_zip].filter(Boolean).join(', ');
      results.push({
        type: 'site',
        site_id: s.site_id,
        customer_id: s.customer_id,
        title: (s.site_name || s.company_name || '—') + (s.store_number ? ' #' + s.store_number : ''),
        subtitle: addr,
        context: s.company_name || '',
        phone: s.billing_phone || '',
        email: s.billing_email || '',
        is_test: !!s.cust_is_test
      });
    });
  }

  // CUSTOMERS — top-level matches
  if (types.includes('customer')) {
    const custs = all(`
      SELECT id, company_name, billing_address, billing_city, billing_state, billing_zip,
             billing_phone, billing_email, is_test_data,
             (SELECT COUNT(*) FROM customer_sites WHERE customer_id = customers.id) AS site_count
      FROM customers
      WHERE (status IS NULL OR status = 'active' OR status = '')
      AND (LOWER(company_name) LIKE ? OR LOWER(billing_address) LIKE ? OR LOWER(billing_city) LIKE ?)
      ORDER BY company_name LIMIT 10`, [q, q, q]);
    custs.forEach(c => {
      const addr = [c.billing_address, [c.billing_city, c.billing_state].filter(Boolean).join(', '), c.billing_zip].filter(Boolean).join(', ');
      results.push({
        type: 'customer',
        customer_id: c.id,
        site_id: 0,
        title: c.company_name || '—',
        subtitle: addr || (c.site_count ? `${c.site_count} location${c.site_count !== 1 ? 's' : ''}` : ''),
        context: c.site_count ? `${c.site_count} site${c.site_count !== 1 ? 's' : ''}` : '',
        phone: c.billing_phone || '',
        email: c.billing_email || '',
        is_test: !!c.is_test_data
      });
    });
  }

  // JOBS — quotes + projects + quick jobs by quote_number / job_number
  if (types.includes('job')) {
    // Quotes (searchable by quote_number; also by project name)
    const quotes = all(`
      SELECT id, quote_number, client_name, project_name, status, customer_id, site_id, is_test_data
      FROM quotes
      WHERE LOWER(quote_number) LIKE ? OR LOWER(project_name) LIKE ?
      LIMIT 10`, [q, q]);
    quotes.forEach(qr => {
      results.push({
        type: 'quote',
        record_id: qr.id,
        customer_id: qr.customer_id || 0,
        site_id: qr.site_id || 0,
        title: '📝 Quote ' + (qr.quote_number || qr.id) + ' — ' + (qr.client_name || '—'),
        subtitle: qr.project_name || '',
        context: qr.status || 'draft',
        is_test: !!qr.is_test_data
      });
    });
    const projects = all(`
      SELECT id, job_number, customer_name, project_name, status, customer_id, site_id, job_type, is_test_data
      FROM projects
      WHERE LOWER(job_number) LIKE ? OR LOWER(project_name) LIKE ?
      LIMIT 10`, [q, q]);
    projects.forEach(pr => {
      const icon = pr.job_type === 'quick_job' ? '⚡' : '📋';
      const label = pr.job_type === 'quick_job' ? 'Quick Job' : 'Project';
      results.push({
        type: pr.job_type || 'project',
        record_id: pr.id,
        customer_id: pr.customer_id || 0,
        site_id: pr.site_id || 0,
        title: icon + ' ' + label + ' ' + (pr.job_number || pr.id) + ' — ' + (pr.customer_name || '—'),
        subtitle: pr.project_name || '',
        context: pr.status || '',
        is_test: !!pr.is_test_data
      });
    });
  }

  res.json({ query: raw, results });
});

// Convenience: GET a single customer's sites (used by quote builder when picking customer-level)
app.get('/api/customers/:id/sites', requireAuth, (req, res) => {
  const sites = all(`SELECT id, site_name, store_number, address, city, state, zip FROM customer_sites
    WHERE customer_id=? ORDER BY site_name`, [req.params.id]);
  res.json(sites);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.2b — JOB LOG (unified quotes + projects + quick jobs + service) ═
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/job-log?month=0426&type=quote&rep=5&status=accepted&search=kroger
app.get('/api/job-log', requireAuth, (req, res) => {
  const { month, type, rep, status, search, include_test } = req.query;
  const includeTest = include_test === '1' || include_test === 'true';
  const params = [];
  const rows = [];

  // Month filter — month_key like "0426"
  // Matching by SUBSTR(created_at, 1, 7) = 'YYYY-MM'; we convert MMYY -> YYYY-MM
  let yyyymm = null;
  if (month && /^\d{4}$/.test(month)) {
    const mm = month.substring(0,2);
    const yy = month.substring(2,4);
    const yyyy = '20' + yy;
    yyyymm = yyyy + '-' + mm;
  }

  const searchLike = search ? '%' + search.toLowerCase() + '%' : null;

  // QUOTES (not type=project, not type=quick_job)
  if (!type || type === 'quote' || type === 'all') {
    let sql = `SELECT id, quote_number AS job_number, created_at, rep_id, rep_name, customer_id, site_id,
      client_name AS customer_name, project_name, scope_summary, status, total AS contract_value,
      is_test_data, 'quote' AS type, NULL AS invoice_number
      FROM quotes WHERE 1=1`;
    const qparams = [];
    if (!includeTest) sql += ' AND (is_test_data IS NULL OR is_test_data=0)';
    if (yyyymm) { sql += " AND SUBSTR(created_at, 1, 7) = ?"; qparams.push(yyyymm); }
    if (rep) { sql += ' AND rep_id=?'; qparams.push(rep); }
    if (status && status !== '') { sql += ' AND status=?'; qparams.push(status); }
    if (searchLike) { sql += ' AND (LOWER(quote_number) LIKE ? OR LOWER(client_name) LIKE ? OR LOWER(project_name) LIKE ?)'; qparams.push(searchLike, searchLike, searchLike); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    all(sql, qparams).forEach(r => rows.push(r));
  }

  // PROJECTS + QUICK JOBS + SERVICE from projects table
  if (!type || type === 'project' || type === 'quick_job' || type === 'service' || type === 'all') {
    let sql = `SELECT p.id, p.job_number, p.created_at,
      p.created_by AS rep_id,
      (SELECT (u.first_name || ' ' || u.last_name) FROM users u WHERE u.id=p.created_by) AS rep_name,
      p.customer_id, p.site_id,
      p.customer_name, p.project_name, p.scope_brief AS scope_summary,
      p.status, p.contract_value, p.is_test_data,
      COALESCE(p.job_type, 'project') AS type,
      p.invoice_number
      FROM projects p WHERE 1=1`;
    const pparams = [];
    if (!includeTest) sql += ' AND (p.is_test_data IS NULL OR p.is_test_data=0)';
    if (type === 'project')   { sql += " AND COALESCE(p.job_type,'project')='project'"; }
    if (type === 'quick_job') { sql += " AND p.job_type='quick_job'"; }
    if (type === 'service')   { sql += " AND p.job_type='service'"; }
    if (yyyymm) { sql += " AND SUBSTR(p.created_at, 1, 7) = ?"; pparams.push(yyyymm); }
    if (rep) { sql += ' AND p.created_by=?'; pparams.push(rep); }
    if (status && status !== '') { sql += ' AND p.status=?'; pparams.push(status); }
    if (searchLike) { sql += ' AND (LOWER(p.job_number) LIKE ? OR LOWER(p.customer_name) LIKE ? OR LOWER(p.project_name) LIKE ?)'; pparams.push(searchLike, searchLike, searchLike); }
    sql += ' ORDER BY p.created_at DESC LIMIT 500';
    all(sql, pparams).forEach(r => rows.push(r));
  }

  // Enrich with site name if site_id is set
  rows.forEach(r => {
    if (r.site_id) {
      const s = get('SELECT site_name, store_number FROM customer_sites WHERE id=?', [r.site_id]);
      if (s) r.site_display = (s.site_name || '') + (s.store_number ? ' #' + s.store_number : '');
    }
  });

  // Sort by created_at desc globally
  rows.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  res.json({ count: rows.length, rows });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.5 — WORKFLOW TASKS (kanban on project detail) ═══════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// List workflow tasks for a project
app.get('/api/projects/:id/workflow-tasks', requireAuth, (req, res) => {
  const tasks = all('SELECT * FROM project_workflow_tasks WHERE project_id=? ORDER BY section, sort_order, id', [req.params.id]);
  res.json(tasks);
});

// Create a single ad-hoc task on a project
app.post('/api/projects/:id/workflow-tasks', requireAuth, (req, res) => {
  const proj = get('SELECT id FROM projects WHERE id=?', [req.params.id]);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const { section, task_name, description, assigned_user_id, due_date, sort_order } = req.body;
  if (!task_name) return res.status(400).json({ error: 'Task name required' });
  let aName = '';
  if (assigned_user_id) {
    const u = get('SELECT first_name,last_name FROM users WHERE id=?', [assigned_user_id]);
    if (u) aName = ((u.first_name||'') + ' ' + (u.last_name||'')).trim();
  }
  const id = runGetId(`INSERT INTO project_workflow_tasks
    (project_id, section, task_name, description, assigned_user_id, assigned_user_name, status, due_date, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [req.params.id, section || 'General', task_name, description || '',
     parseInt(assigned_user_id) || 0, aName, due_date || '', parseInt(sort_order) || 999]);
  // Phase 1.6 — notify the assignee if any
  if (parseInt(assigned_user_id) > 0) {
    try { notifyWorkflowTaskAssigned(id, parseInt(assigned_user_id), req.session.userId); } catch(e){}
  }
  res.json({ ok: true, id });
});

// Update a task (status, assignee, due date, notes, or name/description)
app.put('/api/projects/:id/workflow-tasks/:tid', requireAuth, (req, res) => {
  const task = get('SELECT id FROM project_workflow_tasks WHERE id=? AND project_id=?', [req.params.tid, req.params.id]);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { section, task_name, description, assigned_user_id, status, due_date, notes } = req.body;

  // If assigning a user, resolve the name
  let aName = null;
  if (assigned_user_id !== undefined) {
    if (parseInt(assigned_user_id) > 0) {
      const u = get('SELECT first_name,last_name FROM users WHERE id=?', [assigned_user_id]);
      aName = u ? ((u.first_name||'') + ' ' + (u.last_name||'')).trim() : '';
    } else {
      aName = '';
    }
  }

  // If marking done, record completed_date + completed_by
  let completedDate = null, completedBy = null;
  if (status === 'done') {
    const existing = get('SELECT status FROM project_workflow_tasks WHERE id=?', [req.params.tid]);
    if (existing && existing.status !== 'done') {
      completedDate = new Date().toISOString().split('T')[0];
      completedBy = req.session.userId;
    }
  } else if (status && status !== 'done') {
    // Reopening — clear completed fields
    completedDate = '';
    completedBy = 0;
  }

  const sets = [];
  const params = [];
  if (section !== undefined)          { sets.push('section=?');            params.push(section); }
  if (task_name !== undefined)        { sets.push('task_name=?');          params.push(task_name); }
  if (description !== undefined)      { sets.push('description=?');        params.push(description); }
  if (assigned_user_id !== undefined) { sets.push('assigned_user_id=?');   params.push(parseInt(assigned_user_id)||0); sets.push('assigned_user_name=?'); params.push(aName); }
  if (status !== undefined)           { sets.push('status=?');             params.push(status); }
  if (due_date !== undefined)         { sets.push('due_date=?');           params.push(due_date); }
  if (notes !== undefined)            { sets.push('notes=?');              params.push(notes); }
  if (completedDate !== null)         { sets.push('completed_date=?');     params.push(completedDate); }
  if (completedBy !== null)           { sets.push('completed_by_user_id=?');params.push(completedBy); }

  if (!sets.length) return res.json({ ok: true, updated: 0 });
  sets.push("updated_at=datetime('now')");
  params.push(req.params.tid);
  run(`UPDATE project_workflow_tasks SET ${sets.join(',')} WHERE id=?`, params);
  // Phase 1.6 — if assignee was changed, notify the new assignee
  if (assigned_user_id !== undefined && parseInt(assigned_user_id) > 0) {
    try { notifyWorkflowTaskAssigned(req.params.tid, parseInt(assigned_user_id), req.session.userId); } catch(e){}
  }
  res.json({ ok: true });
});

// Delete a task
app.delete('/api/projects/:id/workflow-tasks/:tid', requireAuth, (req, res) => {
  run('DELETE FROM project_workflow_tasks WHERE id=? AND project_id=?', [req.params.tid, req.params.id]);
  res.json({ ok: true });
});

// Manually seed workflow tasks for an existing project (e.g. older projects created before 1A.5)
app.post('/api/projects/:id/workflow-tasks/seed', requireAuth, (req, res) => {
  const proj = get('SELECT id, created_by FROM projects WHERE id=?', [req.params.id]);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const existing = get('SELECT COUNT(*) AS c FROM project_workflow_tasks WHERE project_id=?', [req.params.id]);
  if (existing && existing.c > 0) return res.status(400).json({ error: 'Project already has workflow tasks. Delete them first if you want to re-seed.' });
  try {
    seedWorkflowTasksForProject(req.params.id, proj.created_by);
    const count = get('SELECT COUNT(*) AS c FROM project_workflow_tasks WHERE project_id=?', [req.params.id]);
    res.json({ ok: true, count: count ? count.c : 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Workflow Templates (Settings management) ────────────────────────────────

app.get('/api/workflow-templates', requireAuth, (req, res) => {
  const templates = all('SELECT * FROM workflow_templates WHERE is_active=1 ORDER BY is_default DESC, name');
  templates.forEach(t => {
    t.tasks = all('SELECT * FROM workflow_template_tasks WHERE template_id=? AND is_active=1 ORDER BY section, sort_order, id', [t.id]);
  });
  res.json(templates);
});

app.post('/api/workflow-templates/:id/tasks', requireAdmin, (req, res) => {
  const tpl = get('SELECT id FROM workflow_templates WHERE id=?', [req.params.id]);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const { section, task_name, description, default_role, default_days_after_start, sort_order } = req.body;
  if (!task_name) return res.status(400).json({ error: 'Task name required' });
  const id = runGetId(`INSERT INTO workflow_template_tasks
    (template_id, section, task_name, description, default_role, default_days_after_start, sort_order, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [req.params.id, section || 'General', task_name, description || '',
     default_role || '', parseInt(default_days_after_start) || 0, parseInt(sort_order) || 999]);
  res.json({ ok: true, id });
});

app.put('/api/workflow-templates/:id/tasks/:tid', requireAdmin, (req, res) => {
  const t = get('SELECT id FROM workflow_template_tasks WHERE id=? AND template_id=?', [req.params.tid, req.params.id]);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const { section, task_name, description, default_role, default_days_after_start, sort_order, is_active } = req.body;
  const sets = [];
  const params = [];
  if (section !== undefined)              { sets.push('section=?');                 params.push(section); }
  if (task_name !== undefined)            { sets.push('task_name=?');               params.push(task_name); }
  if (description !== undefined)          { sets.push('description=?');             params.push(description); }
  if (default_role !== undefined)         { sets.push('default_role=?');            params.push(default_role); }
  if (default_days_after_start !== undefined) { sets.push('default_days_after_start=?'); params.push(parseInt(default_days_after_start)||0); }
  if (sort_order !== undefined)           { sets.push('sort_order=?');              params.push(parseInt(sort_order)||0); }
  if (is_active !== undefined)            { sets.push('is_active=?');               params.push(is_active ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true, updated: 0 });
  params.push(req.params.tid);
  run(`UPDATE workflow_template_tasks SET ${sets.join(',')} WHERE id=?`, params);
  res.json({ ok: true });
});

app.delete('/api/workflow-templates/:id/tasks/:tid', requireAdmin, (req, res) => {
  run('DELETE FROM workflow_template_tasks WHERE id=? AND template_id=?', [req.params.tid, req.params.id]);
  res.json({ ok: true });
});

// ─── Users: get/set workflow_roles for admin UI ──────────────────────────────

app.get('/api/users/workflow-roles', requireAuth, (req, res) => {
  // Returns users with their workflow_roles array
  const users = all(`SELECT id, username, first_name, last_name, role_type, workflow_roles
    FROM users ORDER BY first_name, last_name`);
  users.forEach(u => {
    try { u.workflow_roles = JSON.parse(u.workflow_roles || '[]'); if (!Array.isArray(u.workflow_roles)) u.workflow_roles = []; }
    catch(e) { u.workflow_roles = []; }
  });
  res.json(users);
});

app.put('/api/users/:id/workflow-roles', requireAdmin, (req, res) => {
  const u = get('SELECT id FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const roles = Array.isArray(req.body.workflow_roles) ? req.body.workflow_roles : [];
  const validRoles = ['office_manager','project_manager'];
  const clean = roles.filter(r => validRoles.includes(r));
  run('UPDATE users SET workflow_roles=? WHERE id=?', [JSON.stringify(clean), req.params.id]);
  res.json({ ok: true, workflow_roles: clean });
});

// ═══ PHASE 1A.5 bonus — Quote inline status PATCH (for list page buttons) ═══
app.patch('/api/quotes/:id/status', requireAuth, (req, res) => {
  const q = get('SELECT rep_id FROM quotes WHERE id=?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const role = getUserRole(req.session.userId);
  if (!ADMIN_ROLES.includes(role) && q.rep_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  const { status } = req.body;
  const allowed = ['draft','sent','accepted','declined'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run("UPDATE quotes SET status=?, updated_at=datetime('now') WHERE id=?", [status, req.params.id]);
  // Phase 1.6 — when quote leaves 'sent' status, clear any existing follow-up notifications for this quote
  // and reset the followup_history so if it re-enters 'sent' the cycle starts fresh
  if (status !== 'sent') {
    try {
      run(`UPDATE notifications SET cleared_at=datetime('now') WHERE event_type='quote_followup_due' AND source_type='quote' AND source_id=? AND cleared_at=''`, [req.params.id]);
      run('DELETE FROM followup_history WHERE quote_id=?', [req.params.id]);
    } catch(e) {}
  }
  res.json({ ok: true, status });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1.6 — NOTIFICATIONS + SALES DASHBOARD + FOLLOW-UP REMINDERS ═══════
// ═══════════════════════════════════════════════════════════════════════════════

// Helper — create a notification. Idempotent if you provide a unique source/event combo.
function createNotification(userId, eventType, opts) {
  if (!userId) return null;
  opts = opts || {};
  // De-dupe: if there's already an un-cleared notification with the same user+event+source, skip
  if (opts.dedupe !== false && opts.source_type && opts.source_id) {
    const existing = get(
      `SELECT id FROM notifications WHERE user_id=? AND event_type=? AND source_type=? AND source_id=? AND cleared_at='' LIMIT 1`,
      [userId, eventType, opts.source_type, opts.source_id]
    );
    if (existing) return existing.id;
  }
  const id = runGetId(
    `INSERT INTO notifications (user_id, event_type, source_type, source_id, title, message, action_url, priority, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, eventType, opts.source_type || '', opts.source_id || 0,
     opts.title || '', opts.message || '', opts.action_url || '',
     opts.priority || 'normal', JSON.stringify(opts.metadata || {})]
  );
  return id;
}

// Helper — notify all users with a specific role (used for PTO + attendance broadcasts)
function notifyByRole(roles, eventType, opts) {
  const placeholders = roles.map(() => '?').join(',');
  const users = all(`SELECT id FROM users WHERE role_type IN (${placeholders})`, roles);
  users.forEach(u => createNotification(u.id, eventType, opts));
}

// ─── User-facing notification endpoints ──────────────────────────────────────

app.get('/api/notifications', requireAuth, (req, res) => {
  const { tab } = req.query;  // 'unread' (default) | 'past_due' | 'cleared' | 'all'
  let where = 'user_id=?';
  const params = [req.session.userId];
  if (tab === 'cleared') {
    where += " AND cleared_at != ''";
  } else if (tab === 'past_due') {
    where += " AND cleared_at='' AND created_at < datetime('now','-5 days')";
  } else if (tab === 'all') {
    // no-op, all rows for this user
  } else {
    // unread (default) — uncleared, not snoozed past today
    where += " AND cleared_at=''";
    where += " AND (snoozed_until='' OR snoozed_until <= date('now'))";
  }
  const rows = all(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  rows.forEach(n => {
    try { n.metadata = JSON.parse(n.metadata||'{}'); } catch(e) { n.metadata = {}; }
  });
  res.json({ rows, count: rows.length });
});

// Lightweight unread count for the bell badge
app.get('/api/notifications/count', requireAuth, (req, res) => {
  const row = get(
    `SELECT COUNT(*) AS unread FROM notifications WHERE user_id=? AND cleared_at='' AND read_at=''
       AND (snoozed_until='' OR snoozed_until <= date('now'))`,
    [req.session.userId]
  );
  const pastDueRow = get(
    `SELECT COUNT(*) AS past_due FROM notifications WHERE user_id=? AND cleared_at='' AND created_at < datetime('now','-5 days')`,
    [req.session.userId]
  );
  res.json({ unread: row ? row.unread : 0, past_due: pastDueRow ? pastDueRow.past_due : 0 });
});

// Mark one notification read
app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
  run(`UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=? AND read_at=''`,
    [req.params.id, req.session.userId]);
  res.json({ ok: true });
});

// Clear (mark done) one notification
app.patch('/api/notifications/:id/clear', requireAuth, (req, res) => {
  run(`UPDATE notifications SET cleared_at=datetime('now'), read_at=COALESCE(NULLIF(read_at,''), datetime('now')) WHERE id=? AND user_id=?`,
    [req.params.id, req.session.userId]);
  res.json({ ok: true });
});

// Snooze a notification N days
app.patch('/api/notifications/:id/snooze', requireAuth, (req, res) => {
  const days = parseInt(req.body && req.body.days) || 1;
  run(`UPDATE notifications SET snoozed_until=date('now','+' || ? || ' days') WHERE id=? AND user_id=?`,
    [days, req.params.id, req.session.userId]);
  res.json({ ok: true });
});

// Mark all read
app.patch('/api/notifications/mark-all-read', requireAuth, (req, res) => {
  run(`UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at='' AND cleared_at=''`,
    [req.session.userId]);
  res.json({ ok: true });
});

// Clear all read
app.patch('/api/notifications/clear-all', requireAuth, (req, res) => {
  run(`UPDATE notifications SET cleared_at=datetime('now') WHERE user_id=? AND cleared_at='' AND read_at != ''`,
    [req.session.userId]);
  res.json({ ok: true });
});

// ─── Quote follow-up scheduled job ───────────────────────────────────────────
// Runs once daily; for each sent quote, fires notifications at 3/7/14/30-day milestones if not already fired.
const FOLLOWUP_MILESTONES = [3, 7, 14, 30];
function runQuoteFollowupJob() {
  try {
    console.log('[1.6] Running quote follow-up job...');
    const sent = all(`SELECT id, quote_number, client_name, project_name, rep_id, rep_name, total, updated_at
      FROM quotes WHERE status='sent' AND (is_test_data IS NULL OR is_test_data=0)`);
    let fired = 0;
    const now = new Date();
    sent.forEach(q => {
      if (!q.updated_at || !q.rep_id) return;
      const updatedAt = new Date(q.updated_at.replace(' ', 'T') + 'Z');
      if (isNaN(updatedAt.getTime())) return;
      const ageDays = Math.floor((now - updatedAt) / (1000 * 60 * 60 * 24));
      // For each milestone, if quote is currently at-or-past that milestone AND we've not fired this milestone yet, fire it.
      FOLLOWUP_MILESTONES.forEach(milestone => {
        if (ageDays < milestone) return;
        // Check if we've already fired this milestone for this quote
        const exists = get('SELECT id FROM followup_history WHERE quote_id=? AND milestone_days=?', [q.id, milestone]);
        if (exists) return;
        // Fire
        const isLast = milestone === 30;
        const title = isLast
          ? `⚠ Quote ${q.quote_number || '#'+q.id} idle 30 days — likely lost?`
          : `Follow up on quote ${q.quote_number || '#'+q.id} — ${milestone} days idle`;
        const message = `${q.client_name || 'Client'} · ${q.project_name || ''} · ${q.total ? '$' + q.total : ''}`;
        createNotification(q.rep_id, 'quote_followup_due', {
          source_type: 'quote',
          source_id: q.id,
          title,
          message,
          priority: isLast ? 'urgent' : 'normal',
          metadata: { quote_number: q.quote_number, milestone_days: milestone, age_days: ageDays },
          dedupe: false  // we use followup_history for dedup, not the dedup flag
        });
        run('INSERT INTO followup_history (quote_id, milestone_days) VALUES (?,?)', [q.id, milestone]);
        fired++;
      });
    });
    console.log(`[1.6] Quote follow-up job complete. Fired ${fired} notifications across ${sent.length} sent quotes.`);
  } catch(e) { console.error('[1.6] Follow-up job error:', e); }
}

// Schedule job: run once on boot 30 seconds after startup, then daily at 8 AM
setTimeout(() => runQuoteFollowupJob(), 30 * 1000);
function scheduleNextDailyRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);  // tomorrow at 8 AM
  const ms = next - now;
  setTimeout(() => {
    runQuoteFollowupJob();
    scheduleNextDailyRun();
  }, ms);
}
scheduleNextDailyRun();

// Manual trigger for the job (admin only, useful for testing)
app.post('/api/admin/run-followup-job', requireAdmin, (req, res) => {
  runQuoteFollowupJob();
  res.json({ ok: true, message: 'Follow-up job ran. Check server logs.' });
});

// ─── Hooks: emit notifications when events occur ─────────────────────────────

// Hook: project note added → notify the project owner (created_by) if not the same person
function notifyProjectNoteAdded(projectId, noteText, addedByUserId) {
  try {
    const proj = get('SELECT id, project_name, customer_name, job_number, created_by FROM projects WHERE id=?', [projectId]);
    if (!proj || !proj.created_by || proj.created_by === addedByUserId) return;
    const addedBy = get('SELECT first_name, last_name FROM users WHERE id=?', [addedByUserId]);
    const addedByName = addedBy ? ((addedBy.first_name||'') + ' ' + (addedBy.last_name||'')).trim() : 'someone';
    createNotification(proj.created_by, 'project_note_added', {
      source_type: 'project',
      source_id: proj.id,
      title: `New note on ${proj.job_number || proj.project_name}`,
      message: `${addedByName}: ${(noteText||'').substring(0, 120)}${(noteText||'').length > 120 ? '...' : ''}`,
      priority: 'normal'
    });
  } catch(e) { console.error('notifyProjectNoteAdded error:', e); }
}

// Hook: workflow task assigned → notify assignee
function notifyWorkflowTaskAssigned(taskId, assignedUserId, assignedByUserId) {
  if (!assignedUserId || assignedUserId === assignedByUserId) return;
  try {
    const t = get(`SELECT t.task_name, t.section, t.due_date, p.project_name, p.job_number, p.id AS project_id
      FROM project_workflow_tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`, [taskId]);
    if (!t) return;
    createNotification(assignedUserId, 'task_assigned', {
      source_type: 'workflow_task',
      source_id: taskId,
      title: `Task assigned: ${t.task_name}`,
      message: `${t.job_number || t.project_name || 'Project'} · ${t.section || ''}${t.due_date ? ' · due ' + t.due_date : ''}`,
      priority: 'normal',
      metadata: { project_id: t.project_id }
    });
  } catch(e) { console.error('notifyWorkflowTaskAssigned error:', e); }
}

// Hook: PTO request created → notify all admins + managers
function notifyPTORequestPending(requestId) {
  try {
    const r = get(`SELECT pr.*, (u.first_name || ' ' || u.last_name) AS requester_name
      FROM pto_requests pr LEFT JOIN users u ON u.id=pr.user_id WHERE pr.id=?`, [requestId]);
    if (!r) return;
    notifyByRole(['admin','global_admin','manager'], 'pto_request_pending', {
      source_type: 'pto_request',
      source_id: requestId,
      title: `PTO request from ${r.requester_name || 'employee'}`,
      message: `${r.start_date} to ${r.end_date} · ${r.reason || ''}`,
      priority: 'normal'
    });
  } catch(e) { console.error('notifyPTORequestPending error:', e); }
}

// ─── Sales Dashboard data endpoint ───────────────────────────────────────────
// Returns aggregated metrics for the requesting user (or any user, for managers)
app.get('/api/sales-dashboard', requireAuth, (req, res) => {
  // Determine target rep: by default, the requesting user; managers/admins can ?rep=ID for someone else, ?rep=all for everyone
  const requesterRole = getUserRole(req.session.userId);
  const isManager = ['admin','global_admin','manager'].includes(requesterRole);
  let repFilter = '';
  let repParams = [];
  let viewingRepId = req.session.userId;
  let viewingRepName = '';
  let viewingScope = 'me';

  if (isManager && req.query.rep) {
    if (req.query.rep === 'all') {
      repFilter = '';
      viewingRepId = 0;
      viewingScope = 'all';
    } else {
      const r = parseInt(req.query.rep) || 0;
      if (r) {
        repFilter = ' AND rep_id=?';
        repParams = [r];
        viewingRepId = r;
        viewingScope = 'specific';
      }
    }
  } else {
    // Non-manager — always self
    repFilter = ' AND rep_id=?';
    repParams = [req.session.userId];
  }

  // Get viewing rep name
  if (viewingRepId) {
    const u = get('SELECT first_name, last_name FROM users WHERE id=?', [viewingRepId]);
    if (u) viewingRepName = ((u.first_name||'') + ' ' + (u.last_name||'')).trim();
  }

  // Month filter
  const month = req.query.month || ''; // YYYY-MM format
  let monthFilter = '';
  let monthParams = [];
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    monthFilter = " AND SUBSTR(created_at, 1, 7)=?";
    monthParams = [month];
  }

  const baseExclude = ' AND (is_test_data IS NULL OR is_test_data=0)';

  // Pipeline counts (current state, not month-bound)
  const draftCount = get(`SELECT COUNT(*) AS c FROM quotes WHERE status='draft'${repFilter}${baseExclude}`, repParams);
  const sentCount  = get(`SELECT COUNT(*) AS c FROM quotes WHERE status='sent'${repFilter}${baseExclude}`, repParams);

  // Awarded this month — quotes accepted in the selected month
  const awardedThisMonthQuotes = get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(CAST(REPLACE(REPLACE(total,',',''),'$','') AS REAL)),0) AS sum_total
     FROM quotes WHERE status='accepted'${repFilter}${baseExclude}${monthFilter ? ' AND SUBSTR(updated_at,1,7)=?' : ''}`,
    [...repParams, ...monthParams]
  );

  // Lost this month
  const lostThisMonth = get(
    `SELECT COUNT(*) AS c FROM quotes WHERE status='declined'${repFilter}${baseExclude}${monthFilter ? ' AND SUBSTR(updated_at,1,7)=?' : ''}`,
    [...repParams, ...monthParams]
  );

  // Quotes sent (any status, created in the month)
  const sentThisMonth = get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(CAST(REPLACE(REPLACE(total,',',''),'$','') AS REAL)),0) AS sum_total
     FROM quotes WHERE 1=1${repFilter}${baseExclude}${monthFilter}`,
    [...repParams, ...monthParams]
  );

  const winRate = (awardedThisMonthQuotes.c + lostThisMonth.c) > 0
    ? (awardedThisMonthQuotes.c / (awardedThisMonthQuotes.c + lostThisMonth.c) * 100).toFixed(1)
    : '0.0';

  // Follow-up queue — sent quotes idle, with age
  const followups = all(
    `SELECT id, quote_number, client_name, project_name, total, updated_at,
       CAST((julianday('now') - julianday(updated_at)) AS INTEGER) AS age_days
     FROM quotes WHERE status='sent'${repFilter}${baseExclude}
     ORDER BY updated_at ASC LIMIT 50`,
    repParams
  );
  // Bucket the followups
  const followupBuckets = { fresh: [], aging: [], urgent: [], stale: [] };
  followups.forEach(f => {
    if (f.age_days < 3)        followupBuckets.fresh.push(f);
    else if (f.age_days < 7)   followupBuckets.aging.push(f);
    else if (f.age_days < 14)  followupBuckets.urgent.push(f);
    else                       followupBuckets.stale.push(f);
  });

  // Awarded pipeline (active projects + quick jobs the rep won)
  const activePipelineSql = `SELECT id, job_number, project_name, customer_name, status, contract_value, job_type, material_status, updated_at
    FROM projects WHERE created_by=? AND status NOT IN ('complete','cancelled')${baseExclude}
    ORDER BY updated_at DESC LIMIT 50`;
  const activePipeline = (viewingScope === 'all')
    ? all(`SELECT id, job_number, project_name, customer_name, status, contract_value, job_type, material_status, updated_at
        FROM projects WHERE status NOT IN ('complete','cancelled')${baseExclude}
        ORDER BY updated_at DESC LIMIT 50`)
    : all(activePipelineSql, [viewingRepId]);

  // My quotes (recent, all statuses, this month if filter set)
  const myQuotes = all(
    `SELECT id, quote_number, client_name, project_name, status, total, updated_at
     FROM quotes WHERE 1=1${repFilter}${baseExclude}${monthFilter}
     ORDER BY updated_at DESC LIMIT 100`,
    [...repParams, ...monthParams]
  );

  res.json({
    viewing_rep_id: viewingRepId,
    viewing_rep_name: viewingRepName,
    viewing_scope: viewingScope,
    is_manager: isManager,
    month: month,
    pipeline: {
      drafts: draftCount ? draftCount.c : 0,
      sent: sentCount ? sentCount.c : 0,
      awarded_this_month_count: awardedThisMonthQuotes ? awardedThisMonthQuotes.c : 0,
      awarded_this_month_value: awardedThisMonthQuotes ? awardedThisMonthQuotes.sum_total : 0,
      lost_this_month: lostThisMonth ? lostThisMonth.c : 0,
      sent_this_month_count: sentThisMonth ? sentThisMonth.c : 0,
      sent_this_month_value: sentThisMonth ? sentThisMonth.sum_total : 0,
      win_rate_pct: winRate
    },
    followups: followupBuckets,
    active_pipeline: activePipeline,
    my_quotes: myQuotes
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.6 — EQUIPMENT PO GENERATOR ═════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// Helper — allocate next equipment PO number ("EQ-MMYY-N")
function allocateNextEquipmentPONumber() {
  const key = currentMonthKey();  // e.g. "0426"
  const row = get('SELECT last_seq FROM equipment_po_sequence WHERE month_key=?', [key]);
  const next = row ? (row.last_seq || 0) + 1 : 1;
  if (row) {
    run('UPDATE equipment_po_sequence SET last_seq=? WHERE month_key=?', [next, key]);
  } else {
    run('INSERT INTO equipment_po_sequence (month_key, last_seq) VALUES (?, ?)', [key, next]);
  }
  saveDb();
  return `EQ-${key}-${next}`;
}

// ─── Equipment Vendors ───────────────────────────────────────────────────────
app.get('/api/equipment-vendors', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM equipment_vendors WHERE is_active=1 ORDER BY company_name'));
});
app.post('/api/equipment-vendors', requireAdmin, (req, res) => {
  const { company_name, main_phone, main_email, address, account_number, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!company_name) return res.status(400).json({error:'Vendor name required'});
  const id = runGetId(`INSERT INTO equipment_vendors (company_name, main_phone, main_email, address, account_number, contact_name, contact_email, contact_phone, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [company_name, main_phone||'', main_email||'', address||'', account_number||'', contact_name||'', contact_email||'', contact_phone||'', notes||'']);
  res.json({id});
});
app.put('/api/equipment-vendors/:id', requireAdmin, (req, res) => {
  const v = get('SELECT id FROM equipment_vendors WHERE id=?', [req.params.id]);
  if (!v) return res.status(404).json({error:'Not found'});
  const { company_name, main_phone, main_email, address, account_number, contact_name, contact_email, contact_phone, notes } = req.body;
  run(`UPDATE equipment_vendors SET company_name=?, main_phone=?, main_email=?, address=?, account_number=?, contact_name=?, contact_email=?, contact_phone=?, notes=? WHERE id=?`,
    [company_name, main_phone||'', main_email||'', address||'', account_number||'', contact_name||'', contact_email||'', contact_phone||'', notes||'', req.params.id]);
  res.json({ok:true});
});
app.delete('/api/equipment-vendors/:id', requireAdmin, (req, res) => {
  // Soft-delete (preserve historical PO references)
  run('UPDATE equipment_vendors SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ok:true});
});

// ─── Equipment Catalog ───────────────────────────────────────────────────────
app.get('/api/equipment-catalog', requireAuth, (req, res) => {
  const items = all(`SELECT c.*, v.company_name AS vendor_name FROM equipment_catalog c
    LEFT JOIN equipment_vendors v ON v.id=c.vendor_id WHERE c.is_active=1 ORDER BY c.category, c.name`);
  res.json(items);
});
app.post('/api/equipment-catalog', requireAdmin, (req, res) => {
  const { name, vendor_id, category, daily_rate, weekly_rate, monthly_rate, notes } = req.body;
  if (!name) return res.status(400).json({error:'Equipment name required'});
  const id = runGetId(`INSERT INTO equipment_catalog (name, vendor_id, category, daily_rate, weekly_rate, monthly_rate, notes)
    VALUES (?,?,?,?,?,?,?)`,
    [name, parseInt(vendor_id)||0, category||'', parseFloat(daily_rate)||0, parseFloat(weekly_rate)||0, parseFloat(monthly_rate)||0, notes||'']);
  res.json({id});
});
app.put('/api/equipment-catalog/:id', requireAdmin, (req, res) => {
  const c = get('SELECT id FROM equipment_catalog WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({error:'Not found'});
  const { name, vendor_id, category, daily_rate, weekly_rate, monthly_rate, notes } = req.body;
  run(`UPDATE equipment_catalog SET name=?, vendor_id=?, category=?, daily_rate=?, weekly_rate=?, monthly_rate=?, notes=? WHERE id=?`,
    [name, parseInt(vendor_id)||0, category||'', parseFloat(daily_rate)||0, parseFloat(weekly_rate)||0, parseFloat(monthly_rate)||0, notes||'', req.params.id]);
  res.json({ok:true});
});
app.delete('/api/equipment-catalog/:id', requireAdmin, (req, res) => {
  run('UPDATE equipment_catalog SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ok:true});
});

// ─── Equipment POs ───────────────────────────────────────────────────────────
// List all POs for a project (or all POs)
app.get('/api/equipment-pos', requireAuth, (req, res) => {
  const { project_id } = req.query;
  let sql = `SELECT po.*, v.company_name AS vendor_name_resolved
    FROM equipment_pos po LEFT JOIN equipment_vendors v ON v.id=po.vendor_id`;
  const params = [];
  if (project_id) { sql += ' WHERE po.project_id=?'; params.push(project_id); }
  sql += ' ORDER BY po.created_at DESC';
  const rows = all(sql, params);
  rows.forEach(po => {
    po.items = all('SELECT * FROM equipment_po_items WHERE po_id=? ORDER BY sort_order, id', [po.id]);
  });
  res.json(rows);
});

app.get('/api/equipment-pos/:id', requireAuth, (req, res) => {
  const po = get(`SELECT po.*, v.company_name AS vendor_name_resolved, v.main_email AS vendor_main_email,
                    v.contact_email AS vendor_contact_email, v.contact_name AS vendor_contact_name,
                    v.account_number AS vendor_account_number
    FROM equipment_pos po LEFT JOIN equipment_vendors v ON v.id=po.vendor_id WHERE po.id=?`, [req.params.id]);
  if (!po) return res.status(404).json({error:'Not found'});
  po.items = all('SELECT * FROM equipment_po_items WHERE po_id=? ORDER BY sort_order, id', [po.id]);
  res.json(po);
});

// Create a new PO (status=draft) — pre-fills from project context
app.post('/api/equipment-pos', requireAuth, (req, res) => {
  const { project_id, vendor_id, items, delivery_date, delivery_time_window, return_date, delivery_notes, notes } = req.body;
  if (!project_id) return res.status(400).json({error:'project_id required'});
  const proj = get(`SELECT id, project_name, location, foreman_id, foreman_name, created_by, customer_name, job_number, material_expected_date FROM projects WHERE id=?`, [project_id]);
  if (!proj) return res.status(404).json({error:'Project not found'});
  // Pre-fill contacts from project
  const foreman = proj.foreman_id ? get('SELECT first_name, last_name, phone FROM users WHERE id=?', [proj.foreman_id]) : null;
  const salesRep = proj.created_by ? get('SELECT first_name, last_name, phone, email FROM users WHERE id=?', [proj.created_by]) : null;
  const vendor = vendor_id ? get('SELECT company_name FROM equipment_vendors WHERE id=?', [vendor_id]) : null;
  // Default delivery date: 1 day before material expected date if known, else 7 days from today
  let dDate = delivery_date || '';
  if (!dDate && proj.material_expected_date) {
    const d = new Date(proj.material_expected_date + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    dDate = d.toISOString().split('T')[0];
  }
  if (!dDate) {
    const d = new Date(); d.setDate(d.getDate() + 7);
    dDate = d.toISOString().split('T')[0];
  }
  const poNumber = allocateNextEquipmentPONumber();
  const jobName = (proj.job_number ? proj.job_number + ' — ' : '') + (proj.project_name || proj.customer_name || '');
  const poId = runGetId(`INSERT INTO equipment_pos
    (po_number, project_id, vendor_id, vendor_name, job_name, job_address,
     lead_tech_id, lead_tech_name, lead_tech_phone,
     sales_rep_id, sales_rep_name, sales_rep_phone, sales_rep_email,
     delivery_date, delivery_time_window, return_date, delivery_notes,
     status, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [poNumber, project_id, parseInt(vendor_id)||0, vendor ? vendor.company_name : '',
     jobName, proj.location || '',
     proj.foreman_id || 0, foreman ? ((foreman.first_name||'') + ' ' + (foreman.last_name||'')).trim() : (proj.foreman_name||''), foreman ? (foreman.phone||'') : '',
     proj.created_by || 0, salesRep ? ((salesRep.first_name||'') + ' ' + (salesRep.last_name||'')).trim() : '', salesRep ? (salesRep.phone||'') : '', salesRep ? (salesRep.email||'') : '',
     dDate, delivery_time_window||'', return_date||'', delivery_notes||'',
     'draft', notes||'', req.session.userId]);
  // Insert items
  let totalEst = 0;
  if (Array.isArray(items)) {
    items.forEach((it, idx) => {
      const qty = parseFloat(it.qty) || 1;
      const rate = parseFloat(it.rate) || 0;
      const period = it.rate_period || 'day';
      // Estimated cost — naive: qty × rate (user will adjust based on actual rental period later)
      const est = qty * rate;
      totalEst += est;
      run(`INSERT INTO equipment_po_items (po_id, catalog_id, description, qty, rate, rate_period, estimated_cost, sort_order)
        VALUES (?,?,?,?,?,?,?,?)`,
        [poId, parseInt(it.catalog_id)||0, it.description||'', qty, rate, period, est, idx]);
    });
  }
  run('UPDATE equipment_pos SET total_estimated_cost=? WHERE id=?', [totalEst, poId]);
  res.json({ok:true, id: poId, po_number: poNumber});
});

// Update an existing PO (only if still draft)
app.put('/api/equipment-pos/:id', requireAuth, (req, res) => {
  const po = get('SELECT id, status FROM equipment_pos WHERE id=?', [req.params.id]);
  if (!po) return res.status(404).json({error:'Not found'});
  if (po.status !== 'draft') return res.status(400).json({error:'Cannot edit PO once sent. Cancel and create a new one if changes are needed.'});
  const { vendor_id, items, delivery_date, delivery_time_window, return_date, delivery_notes, notes,
          lead_tech_id, lead_tech_name, lead_tech_phone, sales_rep_id, sales_rep_name, sales_rep_phone, sales_rep_email,
          job_address } = req.body;
  const vendor = vendor_id ? get('SELECT company_name FROM equipment_vendors WHERE id=?', [vendor_id]) : null;
  run(`UPDATE equipment_pos SET vendor_id=?, vendor_name=?,
       lead_tech_id=?, lead_tech_name=?, lead_tech_phone=?,
       sales_rep_id=?, sales_rep_name=?, sales_rep_phone=?, sales_rep_email=?,
       job_address=COALESCE(?, job_address),
       delivery_date=?, delivery_time_window=?, return_date=?, delivery_notes=?, notes=?
       WHERE id=?`,
    [parseInt(vendor_id)||0, vendor ? vendor.company_name : '',
     parseInt(lead_tech_id)||0, lead_tech_name||'', lead_tech_phone||'',
     parseInt(sales_rep_id)||0, sales_rep_name||'', sales_rep_phone||'', sales_rep_email||'',
     job_address,
     delivery_date||'', delivery_time_window||'', return_date||'', delivery_notes||'', notes||'',
     req.params.id]);
  // Replace items
  if (Array.isArray(items)) {
    run('DELETE FROM equipment_po_items WHERE po_id=?', [req.params.id]);
    let totalEst = 0;
    items.forEach((it, idx) => {
      const qty = parseFloat(it.qty) || 1;
      const rate = parseFloat(it.rate) || 0;
      const period = it.rate_period || 'day';
      const est = qty * rate;
      totalEst += est;
      run(`INSERT INTO equipment_po_items (po_id, catalog_id, description, qty, rate, rate_period, estimated_cost, sort_order)
        VALUES (?,?,?,?,?,?,?,?)`,
        [req.params.id, parseInt(it.catalog_id)||0, it.description||'', qty, rate, period, est, idx]);
    });
    run('UPDATE equipment_pos SET total_estimated_cost=? WHERE id=?', [totalEst, req.params.id]);
  }
  res.json({ok:true});
});

// Mark PO as sent (changes status, captures sent_at, optionally creates project_costs row)
app.post('/api/equipment-pos/:id/send', requireAuth, (req, res) => {
  const po = get('SELECT * FROM equipment_pos WHERE id=?', [req.params.id]);
  if (!po) return res.status(404).json({error:'Not found'});
  if (po.status !== 'draft') return res.status(400).json({error:'PO already sent.'});
  const { email_sent_to } = req.body || {};
  run(`UPDATE equipment_pos SET status='sent', sent_at=datetime('now'), email_sent_to=? WHERE id=?`,
    [email_sent_to || '', req.params.id]);
  // Auto-create a corresponding project_costs row (category=equipment) so the project shows the encumbered cost
  const proj = get('SELECT id FROM projects WHERE id=?', [po.project_id]);
  if (proj) {
    const items = all('SELECT description FROM equipment_po_items WHERE po_id=?', [po.id]);
    const description = (items.length ? items.map(i => i.description).join('; ') : 'Equipment rental') + ` (${po.po_number})`;
    const costId = runGetId(`INSERT INTO project_costs
      (project_id, category, vendor, description, quantity, unit_cost, total_cost, invoice_number, invoice_date, po_number, notes, logged_by)
      VALUES (?, 'equipment', ?, ?, 1, ?, ?, '', ?, ?, ?, ?)`,
      [po.project_id, po.vendor_name||'', description, po.total_estimated_cost, po.total_estimated_cost,
       po.delivery_date || '', po.po_number, 'Auto-created from equipment PO', 'system']);
    run('UPDATE equipment_pos SET cost_id=? WHERE id=?', [costId, req.params.id]);
  }
  res.json({ok:true, status:'sent'});
});

// Confirm PO (vendor confirmed delivery)
app.post('/api/equipment-pos/:id/confirm', requireAuth, (req, res) => {
  const po = get('SELECT id, status FROM equipment_pos WHERE id=?', [req.params.id]);
  if (!po) return res.status(404).json({error:'Not found'});
  if (po.status === 'cancelled') return res.status(400).json({error:'PO is cancelled.'});
  const { confirmation_number } = req.body || {};
  run(`UPDATE equipment_pos SET status='confirmed', confirmation_number=? WHERE id=?`,
    [confirmation_number||'', req.params.id]);
  res.json({ok:true});
});

// Cancel PO (and remove the project cost row if it was created)
app.post('/api/equipment-pos/:id/cancel', requireAuth, (req, res) => {
  const po = get('SELECT id, cost_id FROM equipment_pos WHERE id=?', [req.params.id]);
  if (!po) return res.status(404).json({error:'Not found'});
  run(`UPDATE equipment_pos SET status='cancelled' WHERE id=?`, [req.params.id]);
  if (po.cost_id) {
    run('DELETE FROM project_costs WHERE id=?', [po.cost_id]);
  }
  res.json({ok:true});
});

// Hard-delete a draft PO (only if it's never been sent)
app.delete('/api/equipment-pos/:id', requireAuth, (req, res) => {
  const po = get('SELECT id, status FROM equipment_pos WHERE id=?', [req.params.id]);
  if (!po) return res.status(404).json({error:'Not found'});
  if (po.status !== 'draft' && po.status !== 'cancelled') {
    return res.status(400).json({error:'Can only delete draft or cancelled POs. Cancel it first if it was sent.'});
  }
  run('DELETE FROM equipment_po_items WHERE po_id=?', [req.params.id]);
  run('DELETE FROM equipment_pos WHERE id=?', [req.params.id]);
  res.json({ok:true});
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.4a — BILLING MODULE (Erin's AP Dashboard + Invoice Entry) ══════
// ═══════════════════════════════════════════════════════════════════════════════

const BILLING_ROLES = ['billing','admin','global_admin'];
function requireBilling(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const role = getUserRole(req.session.userId);
  if (!BILLING_ROLES.includes(role)) return res.status(403).json({ error: 'Billing access required' });
  next();
}

// ─── Bill Vendors CRUD ───────────────────────────────────────────────────────

app.get('/api/bill-vendors', requireAuth, (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  let sql = `SELECT id, name, contact_name, email, phone, address, account_number, terms, default_gl_account, last_used_at FROM bill_vendors WHERE is_active=1`;
  const params = [];
  if (search) {
    sql += ` AND (LOWER(name) LIKE ? OR LOWER(contact_name) LIKE ?)`;
    const q = '%' + search.toLowerCase() + '%';
    params.push(q, q);
  }
  // Order: most recently used first, then alphabetical
  sql += ` ORDER BY (CASE WHEN last_used_at='' THEN 1 ELSE 0 END), last_used_at DESC, name LIMIT ?`;
  params.push(limit);
  res.json(all(sql, params));
});

app.post('/api/bill-vendors', requireBilling, (req, res) => {
  const { name, contact_name, email, phone, address, account_number, terms, default_gl_account, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Vendor name required' });
  // Check for existing (idempotent — return existing id if name matches)
  const existing = get('SELECT id FROM bill_vendors WHERE LOWER(name)=LOWER(?)', [name.trim()]);
  if (existing) return res.json({ id: existing.id, existed: true });
  try {
    const id = runGetId(`INSERT INTO bill_vendors (name, contact_name, email, phone, address, account_number, terms, default_gl_account, notes)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [name.trim(), contact_name||'', email||'', phone||'', address||'', account_number||'', terms||'', default_gl_account||'', notes||'']);
    res.json({ id, existed: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bill-vendors/:id', requireBilling, (req, res) => {
  const v = get('SELECT id FROM bill_vendors WHERE id=?', [req.params.id]);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const { name, contact_name, email, phone, address, account_number, terms, default_gl_account, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Vendor name required' });
  run(`UPDATE bill_vendors SET name=?, contact_name=?, email=?, phone=?, address=?, account_number=?, terms=?, default_gl_account=?, notes=? WHERE id=?`,
    [name.trim(), contact_name||'', email||'', phone||'', address||'', account_number||'', terms||'', default_gl_account||'', notes||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/bill-vendors/:id', requireBilling, (req, res) => {
  // Soft delete to preserve history
  run('UPDATE bill_vendors SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// CSV import endpoint — accepts a CSV body (string), parses, inserts new vendors
// Expected QB export format: name in column 1; everything else optional
// Tries common QB column header names: "Company", "Name", "Vendor", "Email", "Phone", "Account No", etc.
app.post('/api/bill-vendors/import-csv', requireBilling, (req, res) => {
  const { csv, dry_run } = req.body || {};
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv body required' });
  // Naive CSV parser — handles quoted fields and commas inside quotes
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuote) {
        if (c === '"') {
          if (text[i+1] === '"') { field += '"'; i++; }
          else { inQuote = false; }
        } else { field += c; }
      } else {
        if (c === '"') { inQuote = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i+1] === '\n') i++;
          row.push(field); rows.push(row);
          row = []; field = '';
        } else { field += c; }
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => f && f.trim()));
  }
  const rows = parseCsv(csv);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });
  // Detect header columns
  const header = rows[0].map(h => (h||'').trim().toLowerCase());
  function findCol(candidates) {
    for (const cand of candidates) {
      const idx = header.findIndex(h => h === cand || h.includes(cand));
      if (idx >= 0) return idx;
    }
    return -1;
  }
  const colName     = findCol(['company','vendor','name','company name','vendor name']);
  const colContact  = findCol(['contact','primary contact','contact name','first name']);
  const colEmail    = findCol(['email','main email']);
  const colPhone    = findCol(['phone','main phone','telephone']);
  const colAddress  = findCol(['address','billing address','street']);
  const colAccount  = findCol(['account','account no','account #','account number']);
  const colTerms    = findCol(['terms','payment terms']);
  if (colName < 0) {
    return res.status(400).json({ error: `CSV must have a column named "Company", "Vendor", or "Name". Found columns: ${header.join(', ')}` });
  }
  const stats = { total_rows: rows.length - 1, inserted: 0, updated: 0, skipped: 0, errors: [] };
  const sample = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[colName]||'').trim();
    if (!name) { stats.skipped++; continue; }
    const data = {
      name,
      contact_name: colContact >= 0 ? (row[colContact]||'').trim() : '',
      email:        colEmail   >= 0 ? (row[colEmail]||'').trim()   : '',
      phone:        colPhone   >= 0 ? (row[colPhone]||'').trim()   : '',
      address:      colAddress >= 0 ? (row[colAddress]||'').trim() : '',
      account_number: colAccount >= 0 ? (row[colAccount]||'').trim() : '',
      terms:        colTerms   >= 0 ? (row[colTerms]||'').trim()   : ''
    };
    if (dry_run) {
      if (sample.length < 5) sample.push(data);
      stats.inserted++;
      continue;
    }
    try {
      const existing = get('SELECT id FROM bill_vendors WHERE LOWER(name)=LOWER(?)', [name]);
      if (existing) {
        // Update missing fields only (don't blow away existing data)
        run(`UPDATE bill_vendors SET
          contact_name=COALESCE(NULLIF(contact_name,''),?),
          email=COALESCE(NULLIF(email,''),?),
          phone=COALESCE(NULLIF(phone,''),?),
          address=COALESCE(NULLIF(address,''),?),
          account_number=COALESCE(NULLIF(account_number,''),?),
          terms=COALESCE(NULLIF(terms,''),?),
          is_active=1
          WHERE id=?`,
          [data.contact_name, data.email, data.phone, data.address, data.account_number, data.terms, existing.id]);
        stats.updated++;
      } else {
        run(`INSERT INTO bill_vendors (name, contact_name, email, phone, address, account_number, terms)
          VALUES (?,?,?,?,?,?,?)`,
          [data.name, data.contact_name, data.email, data.phone, data.address, data.account_number, data.terms]);
        stats.inserted++;
      }
    } catch(e) {
      stats.errors.push({ row: r + 1, name, error: e.message });
    }
  }
  saveDb();
  if (dry_run) stats.sample = sample;
  res.json(stats);
});

// ─── Billing Dashboard data ──────────────────────────────────────────────────

app.get('/api/billing/dashboard', requireBilling, (req, res) => {
  // Tile 1: Quick jobs ready to bill (bill_status='ready_to_bill' OR status='complete' with bill_status != 'billed'/'paid')
  const quickJobsToBill = all(`
    SELECT id, job_number, project_name, customer_name, contract_value, bill_status,
           updated_at,
           CAST((julianday('now') - julianday(updated_at)) AS INTEGER) AS days_since_ready
      FROM projects
     WHERE job_type='quick_job'
       AND status != 'cancelled'
       AND (bill_status='ready_to_bill' OR (status='complete' AND bill_status != 'billed' AND bill_status != 'paid'))
     ORDER BY updated_at ASC
  `);

  // Tile 2: Projects ready to bill — first invoice not yet sent (total_billed_to_date = 0)
  // AND status is at least scheduled (work has begun)
  const projectsNotBilled = all(`
    SELECT id, job_number, project_name, customer_name, contract_value, status, billing_model,
           total_billed_to_date, last_customer_invoice_date,
           updated_at, created_at,
           CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS days_since_created
      FROM projects
     WHERE job_type='project'
       AND status NOT IN ('awarded','shop_drawings','cancelled','complete')
       AND (total_billed_to_date IS NULL OR total_billed_to_date = 0)
     ORDER BY created_at ASC
  `);

  // Tile 3: Stale billing — projects where last_customer_invoice_date > 45 days ago AND not 100% billed
  const staleProjects = all(`
    SELECT id, job_number, project_name, customer_name, contract_value, status, billing_model,
           total_billed_to_date, last_customer_invoice_date,
           CAST((julianday('now') - julianday(last_customer_invoice_date)) AS INTEGER) AS days_since_last_bill
      FROM projects
     WHERE job_type='project'
       AND status NOT IN ('cancelled','complete')
       AND last_customer_invoice_date != ''
       AND last_customer_invoice_date IS NOT NULL
       AND date(last_customer_invoice_date) < date('now','-45 days')
       AND (contract_value IS NULL OR contract_value = 0 OR total_billed_to_date < contract_value)
     ORDER BY last_customer_invoice_date ASC
  `);

  // Tile 4: Stale quick jobs — ready_to_bill > 7 days
  const staleQuickJobs = quickJobsToBill.filter(q => q.days_since_ready > 7);

  // Today's entry stats (cost lines created today by this user across any project)
  const todayCount = get(`
    SELECT COUNT(*) AS c, COALESCE(SUM(total_cost),0) AS total
      FROM project_costs
     WHERE date(created_at) = date('now')
       AND logged_by = ?
  `, [req.session.userId.toString()]);
  // Fallback: if logged_by stored as name not id
  const u = get('SELECT first_name, last_name FROM users WHERE id=?', [req.session.userId]);
  const userName = u ? ((u.first_name||'') + ' ' + (u.last_name||'')).trim() : '';
  const todayCountByName = userName ? get(`
    SELECT COUNT(*) AS c, COALESCE(SUM(total_cost),0) AS total
      FROM project_costs
     WHERE date(created_at) = date('now')
       AND logged_by = ?
  `, [userName]) : null;

  res.json({
    quick_jobs_to_bill: {
      count: quickJobsToBill.length,
      stale_count: staleQuickJobs.length,
      rows: quickJobsToBill,
      stale_rows: staleQuickJobs
    },
    projects_not_billed: {
      count: projectsNotBilled.length,
      rows: projectsNotBilled
    },
    stale_projects: {
      count: staleProjects.length,
      rows: staleProjects
    },
    today_entries: {
      count: Math.max(todayCount ? todayCount.c : 0, todayCountByName ? todayCountByName.c : 0),
      total: Math.max(todayCount ? todayCount.total : 0, todayCountByName ? todayCountByName.total : 0)
    }
  });
});

// ─── Recent invoice entries by current user (for Invoice Entry "Today's recent" list) ─
app.get('/api/billing/recent-entries', requireBilling, (req, res) => {
  const u = get('SELECT first_name, last_name FROM users WHERE id=?', [req.session.userId]);
  const userName = u ? ((u.first_name||'') + ' ' + (u.last_name||'')).trim() : '';
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const rows = all(`
    SELECT pc.id, pc.project_id, pc.category, pc.vendor, pc.description,
           pc.quantity, pc.unit_cost, pc.total_cost, pc.invoice_number, pc.invoice_date,
           pc.po_number, pc.created_at,
           p.job_number, p.project_name, p.customer_name
      FROM project_costs pc
      LEFT JOIN projects p ON p.id = pc.project_id
     WHERE pc.logged_by = ?
        OR pc.logged_by = ?
     ORDER BY pc.created_at DESC
     LIMIT ?
  `, [userName, req.session.userId.toString(), limit]);
  res.json(rows);
});

// ─── Update project's billing_model ─────────────────────────────────────────
app.patch('/api/projects/:id/billing-model', requireAuth, (req, res) => {
  const { billing_model } = req.body;
  const valid = ['', 'lump_sum_on_completion', 'progress_billing', 'monthly_labor_only'];
  if (!valid.includes(billing_model)) return res.status(400).json({ error: 'Invalid billing model' });
  run('UPDATE projects SET billing_model=? WHERE id=?', [billing_model, req.params.id]);
  res.json({ ok: true });
});

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>{
  app.listen(PORT,()=>{
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   KVM Door Systems Portal v3         ║');
    console.log('  ║   Running on http://localhost:'+PORT+'    ║');
    console.log('  ║   Login: admin / admin123            ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
  });
}).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
