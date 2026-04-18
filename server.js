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
  const { quote_number, client_name, contact_name, address, email, phone, project_name, scope_summary, scopes, options, notes, subtotal, tax, total, valid_for, status } = req.body;
  const id = runGetId(`INSERT INTO quotes (quote_number,rep_id,rep_name,client_name,contact_name,address,email,phone,project_name,scope_summary,scopes,options,notes,subtotal,tax,total,valid_for,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [quote_number||'', req.session.userId, rep_name, client_name||'', contact_name||'', address||'', email||'', phone||'', project_name||'', scope_summary||'', JSON.stringify(scopes||[]), JSON.stringify(options||[]), notes||'', subtotal||'', tax||'', total||'', valid_for||'30 days', status||'draft']);
  res.json({ id });
});

app.put('/api/quotes/:id', requireAuth, (req, res) => {
  const q = get('SELECT rep_id FROM quotes WHERE id=?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const role = getUserRole(req.session.userId);
  if (!ADMIN_ROLES.includes(role) && q.rep_id !== req.session.userId) return res.status(403).json({ error: 'Access denied' });
  const { quote_number, client_name, contact_name, address, email, phone, project_name, scope_summary, scopes, options, notes, subtotal, tax, total, valid_for, status } = req.body;
  run(`UPDATE quotes SET quote_number=?,client_name=?,contact_name=?,address=?,email=?,phone=?,project_name=?,scope_summary=?,scopes=?,options=?,notes=?,subtotal=?,tax=?,total=?,valid_for=?,status=?,updated_at=datetime('now') WHERE id=?`,
    [quote_number||'', client_name||'', contact_name||'', address||'', email||'', phone||'', project_name||'', scope_summary||'', JSON.stringify(scopes||[]), JSON.stringify(options||[]), notes||'', subtotal||'', tax||'', total||'', valid_for||'30 days', status||'draft', req.params.id]);
  res.json({ ok: true });
});

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
  const { status, search } = req.query;
  let sql = `SELECT p.*, 
    (SELECT COUNT(*) FROM project_phases WHERE project_id=p.id) as phase_count,
    (SELECT COALESCE(SUM(hours),0) FROM project_hours WHERE project_id=p.id) as total_hours
    FROM projects p WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND p.status=?'; params.push(status); }
  if (search) { sql += ' AND (p.project_name LIKE ? OR p.customer_name LIKE ? OR p.job_number LIKE ?)'; const s='%'+search+'%'; params.push(s,s,s); }
  sql += ' ORDER BY p.updated_at DESC';
  res.json(all(sql, params));
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
  p.total_hours = p.hours.reduce((s,h) => s + (h.hours||0), 0);
  res.json(p);
});

// Create project
app.post('/api/projects', requireAuth, (req, res) => {
  const { job_number, project_name, customer_id, customer_name, site_id, location, quote_id, quote_number,
    contract_value, billing_type, scope_brief, status, start_date, target_end_date, foreman_id, foreman_name,
    assigned_techs, notes } = req.body;
  if (!project_name) return res.status(400).json({error:'Project name required'});
  const id = runGetId(`INSERT INTO projects 
    (job_number,project_name,customer_id,customer_name,site_id,location,quote_id,quote_number,
     contract_value,billing_type,scope_brief,status,start_date,target_end_date,foreman_id,foreman_name,
     assigned_techs,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [job_number||'', project_name, customer_id||0, customer_name||'', site_id||0, location||'',
     quote_id||0, quote_number||'', contract_value||'', billing_type||'aftermarket', scope_brief||'',
     status||'awarded', start_date||'', target_end_date||'', foreman_id||0, foreman_name||'',
     JSON.stringify(assigned_techs||[]), notes||'', req.session.userId]);
  res.json({id});
});

// Update project
app.put('/api/projects/:id', requireAuth, (req, res) => {
  const p = get('SELECT id FROM projects WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({error:'Not found'});
  const { job_number, project_name, customer_id, customer_name, site_id, location, quote_id, quote_number,
    contract_value, billing_type, scope_brief, status, start_date, target_end_date, actual_end_date,
    foreman_id, foreman_name, assigned_techs, notes } = req.body;
  run(`UPDATE projects SET job_number=?,project_name=?,customer_id=?,customer_name=?,site_id=?,location=?,
    quote_id=?,quote_number=?,contract_value=?,billing_type=?,scope_brief=?,status=?,start_date=?,
    target_end_date=?,actual_end_date=?,foreman_id=?,foreman_name=?,assigned_techs=?,notes=?,
    updated_at=datetime('now') WHERE id=?`,
    [job_number||'', project_name, customer_id||0, customer_name||'', site_id||0, location||'',
     quote_id||0, quote_number||'', contract_value||'', billing_type||'aftermarket', scope_brief||'',
     status||'awarded', start_date||'', target_end_date||'', actual_end_date||'', foreman_id||0,
     foreman_name||'', JSON.stringify(assigned_techs||[]), notes||'', req.params.id]);
  res.json({ok:true});
});

app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  run('DELETE FROM projects WHERE id=?', [req.params.id]);
  run('DELETE FROM project_phases WHERE project_id=?', [req.params.id]);
  run('DELETE FROM project_hours WHERE project_id=?', [req.params.id]);
  run('DELETE FROM project_notes WHERE project_id=?', [req.params.id]);
  res.json({ok:true});
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
