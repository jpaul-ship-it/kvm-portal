const express = require('express');
const session = require('express-session');
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
// Use RENDER_DISK_PATH env var for Render persistent disk, fallback to local data dir
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

  // ─── CUSTOMER DATABASE TABLES ─────────────────────────────────────────────
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
    internal_notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    assigned_salesperson_id INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

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
  saveDb();

  // Migrate: add new columns if upgrading
  // Add role_type column for new permission system
  try { db.run(`ALTER TABLE users ADD COLUMN role_type TEXT DEFAULT 'technician'`); saveDb(); } catch(e){}
  ['oncall_dept','oncall_role','paired_with','hire_date'].forEach(col => {
    try { db.run(`ALTER TABLE users ADD COLUMN ${col} TEXT DEFAULT ''`); saveDb(); } catch(e){}
  });
  try { db.run(`ALTER TABLE oncall ADD COLUMN department TEXT DEFAULT ''`); saveDb(); } catch(e){}
  // Create customer database tables if upgrading from older version
  try { db.run(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, company_name TEXT NOT NULL, customer_type TEXT DEFAULT 'End User', is_partner_company INTEGER DEFAULT 0, qb_customer_id TEXT DEFAULT '', billing_address TEXT DEFAULT '', billing_city TEXT DEFAULT '', billing_state TEXT DEFAULT '', billing_zip TEXT DEFAULT '', billing_email TEXT DEFAULT '', billing_phone TEXT DEFAULT '', billing_fax TEXT DEFAULT '', credit_terms TEXT DEFAULT 'Net 30', tax_exempt INTEGER DEFAULT 0, tax_exempt_number TEXT DEFAULT '', union_required INTEGER DEFAULT 0, requires_certified_payroll INTEGER DEFAULT 0, partner_labor_rate_notes TEXT DEFAULT '', partner_billing_hours INTEGER DEFAULT 0, partner_work_order_instructions TEXT DEFAULT '', partner_checkin_instructions TEXT DEFAULT '', partner_billing_email TEXT DEFAULT '', partner_billing_notes TEXT DEFAULT '', internal_notes TEXT DEFAULT '', status TEXT DEFAULT 'active', assigned_salesperson_id INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customer_sites (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, site_name TEXT DEFAULT '', store_number TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '', site_notes TEXT DEFAULT '', access_instructions TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customer_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, site_id INTEGER DEFAULT 0, first_name TEXT NOT NULL, last_name TEXT DEFAULT '', title TEXT DEFAULT '', phone TEXT DEFAULT '', phone2 TEXT DEFAULT '', email TEXT DEFAULT '', is_primary INTEGER DEFAULT 0, is_billing_contact INTEGER DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS customer_equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, site_id INTEGER DEFAULT 0, equipment_type TEXT DEFAULT '', manufacturer TEXT DEFAULT '', model TEXT DEFAULT '', serial_number TEXT DEFAULT '', size TEXT DEFAULT '', install_date TEXT DEFAULT '', last_service_date TEXT DEFAULT '', warranty_expiry TEXT DEFAULT '', condition TEXT DEFAULT '', location_in_site TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS partner_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, doc_type TEXT DEFAULT '', doc_name TEXT NOT NULL, file_name TEXT DEFAULT '', file_data TEXT DEFAULT '', file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0, notes TEXT DEFAULT '', uploaded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS job_numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, prefix TEXT NOT NULL, job_number TEXT UNIQUE NOT NULL, sequence INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS qb_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, sync_type TEXT DEFAULT '', records_synced INTEGER DEFAULT 0, status TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  // Create attendance tables if upgrading
  try { db.run(`CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, event_date TEXT NOT NULL, event_type TEXT NOT NULL, minutes_late INTEGER DEFAULT 0, notes TEXT DEFAULT '', logged_by TEXT DEFAULT 'system', quarter TEXT DEFAULT '', year INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS callins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, call_in_date TEXT NOT NULL, call_in_type TEXT NOT NULL DEFAULT 'Sick', notes TEXT DEFAULT '', notified INTEGER DEFAULT 0, logged_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS attendance_recognition (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, quarter TEXT NOT NULL, year INTEGER NOT NULL, announced INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  // Create timeclock tables if upgrading
  try { db.run(`CREATE TABLE IF NOT EXISTS timeclock (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, clock_type TEXT NOT NULL DEFAULT 'shop', status TEXT NOT NULL DEFAULT 'in', clock_in TEXT, clock_out TEXT, latitude_in REAL, longitude_in REAL, latitude_out REAL, longitude_out REAL, job_name TEXT DEFAULT '', customer_name TEXT DEFAULT '', notes TEXT DEFAULT '', is_union INTEGER DEFAULT 0, is_offsite INTEGER DEFAULT 0, total_minutes INTEGER DEFAULT 0, week_start TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS geofence_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, alert_type TEXT NOT NULL, latitude REAL, longitude REAL, resolved INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  // Create doc tables if upgrading
  try { db.run(`CREATE TABLE IF NOT EXISTS employee_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, doc_name TEXT NOT NULL, doc_type TEXT DEFAULT 'other', expiry_date TEXT DEFAULT '', notes TEXT DEFAULT '', file_name TEXT DEFAULT '', file_data TEXT DEFAULT '', file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}
  try { db.run(`CREATE TABLE IF NOT EXISTS company_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT DEFAULT 'other', description TEXT DEFAULT '', file_name TEXT DEFAULT '', file_data TEXT DEFAULT '', file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0, uploaded_by TEXT NOT NULL, uploaded_at TEXT DEFAULT (datetime('now')))`); saveDb(); } catch(e){}

  const userCount = get('SELECT COUNT(*) as c FROM users');
  if (!userCount || userCount.c === 0) {
    seedDatabase();
  }
}

function seedDatabase() {
  const adminHash = bcrypt.hashSync('admin123', 10);
  const pass = bcrypt.hashSync('pass123', 10);

  // Admin
  db.run(`INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,pto_total,pto_left,avatar_color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['admin',adminHash,'Admin','User','Office Administrator','Management','','','','admin@kvmdoors.com',1,15,15,'#7a5010']);

  // KVM Real Employees
  // Format: [username, pass, first, last, role, dept, oncall_dept, oncall_role, phone, pto_total, pto_left, color]
  //          [0]       [1]   [2]    [3]   [4]   [5]   [6]          [7]          [8]    [9]        [10]      [11]
  const employees = [
    ['mark.todd',    pass,'Mark',   'Todd',      'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0101', 10, 10, '#2980b9'],
    ['mjr',          pass,'MJR',    '',          'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0102', 10, 10, '#8e44ad'],
    ['kevin',        pass,'Kevin',  '',          'Overhead Door Leader',     'Overhead Door', 'Both Divisions',         'Leader', '(313) 555-0103', 10, 10, '#16a085'],
    ['mike.l',       pass,'Mike',   'L',         'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0104', 10, 10, '#b8860b'],
    ['skyler',       pass,'Skyler', '',          'Overhead Door Leader',     'Overhead Door', 'Both Divisions',         'Leader', '(313) 555-0105', 10, 10, '#1a6e3a'],
    ['rob.s',        pass,'Rob',    'S',         'Automatic Door Technician','Automatic Door','Automatic Door Division','Leader', '(313) 555-0106', 10, 10, '#7a5010'],
    ['steve.winter', pass,'Steve',  'Winter Sr.','Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0107', 10, 10, '#5d4e8a'],
    ['k.shaw',       pass,'K',      'Shaw',      'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0108', 10, 10, '#2980b9'],
    ['m5',           pass,'M5',     '',          'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0109', 10, 10, '#8e44ad'],
    ['scott.evans',  pass,'Scott',  'Evans',     'Automatic Door Technician','Automatic Door','Automatic Door Division','Leader', '(313) 555-0110', 10, 10, '#16a085'],
    ['emmet',        pass,'Emmet',  '',          'Overhead Door Helper',     'Overhead Door', 'Overhead Door Division', 'Helper', '(313) 555-0111', 10, 10, '#b8860b'],
    ['anthony',      pass,'Anthony','',          'Overhead Door Helper',     'Overhead Door', 'Overhead Door Division', 'Helper', '(313) 555-0112', 10, 10, '#1a6e3a'],
    ['sherman',      pass,'Sherman','',          'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0113', 10, 10, '#7a5010'],
    ['robert.jr',    pass,'Robert', 'Jr',        'Overhead Door Helper',     'Overhead Door', 'Overhead Door Division', 'Helper', '(313) 555-0114', 10, 10, '#5d4e8a'],
    ['sean.mccann',  pass,'Sean',   'McCann',    'Overhead Door Helper',     'Overhead Door', 'Overhead Door Division', 'Helper', '(313) 555-0115', 10, 10, '#2980b9'],
    ['derek',        pass,'Derek',  '',          'Overhead Door Helper',     'Overhead Door', 'Overhead Door Division', 'Helper', '(313) 555-0116', 10, 10, '#8e44ad'],
    ['jermiah',      pass,'Jermiah','',          'Overhead Door Helper',     'Overhead Door', 'Overhead Door Division', 'Helper', '(313) 555-0117', 10, 10, '#16a085'],
    ['k.berry',       pass,'K',      'Berry',     'Automatic Door Technician','Automatic Door','Automatic Door Division', 'Leader', '(313) 555-0118', 10, 10, '#b8860b'],
    ['lorne',         pass,'Lorne',  '',           'Overhead Door Leader',     'Overhead Door', 'Overhead Door Division', 'Leader', '(313) 555-0119', 10, 10, '#5d4e8a'],
  ];

  employees.forEach(e => {
    db.run(
      `INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,pto_total,pto_left,avatar_color) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], '', e[9], e[10], e[11]]
    );
  });

  // Set paired_with: Mike L <-> Robert Jr
  const mikeL = get('SELECT id FROM users WHERE username=?',['mike.l']);
  const robertJr = get('SELECT id FROM users WHERE username=?',['robert.jr']);
  if (mikeL && robertJr) {
    db.run('UPDATE users SET paired_with=? WHERE id=?',[robertJr.id, mikeL.id]);
    db.run('UPDATE users SET paired_with=? WHERE id=?',[mikeL.id, robertJr.id]);
  }

  // Seed rotation order for Overhead Door (leaders first, then helpers)
  const ohLeaders = ['mark.todd','mjr','kevin','mike.l','skyler','steve.winter','k.shaw','m5','sherman'];
  const ohHelpers = ['emmet','anthony','robert.jr','sean.mccann','derek','jermiah'];
  const ohOrder = [...ohLeaders, ...ohHelpers];
  ohOrder.forEach((uname, idx) => {
    const u = get('SELECT id FROM users WHERE username=?',[uname]);
    if (u) db.run(`INSERT INTO oncall_rotation (department,user_id,position) VALUES (?,?,?)`,['Overhead Door Division',u.id,idx+1]);
  });

  // Auto Door rotation: rob.s, kevin, skyler, scott.evans
  ['rob.s','kevin','skyler','scott.evans'].forEach((uname, idx) => {
    const u = get('SELECT id FROM users WHERE username=?',[uname]);
    if (u) db.run(`INSERT INTO oncall_rotation (department,user_id,position) VALUES (?,?,?)`,['Automatic Door Division',u.id,idx+1]);
  });

  // Sample announcements
  db.run(`INSERT INTO announcements (title,body,priority,author_name) VALUES (?,?,?,?)`,['Welcome to the KVM Employee Portal','Your new portal is live! Check on-call schedules, request PTO, and read company news all in one place.','info','Admin']);
  db.run(`INSERT INTO announcements (title,body,priority,author_name) VALUES (?,?,?,?)`,['Safety Reminder','All field crews must wear full PPE on every job site. Zero exceptions.','urgent','Admin']);
  db.run(`INSERT INTO news (title,body,category,author_name) VALUES (?,?,?,?)`,['KVM Completes 500th Door Installation','Our team hit a major milestone this month. Great work to the whole crew!','Recognition','Admin']);
  db.run(`INSERT INTO news (title,body,category,author_name) VALUES (?,?,?,?)`,['Q2 Safety Record: Zero Incidents','Perfect safety record for Q2. Keep up the excellent awareness on every job site.','Safety','Admin']);

  // Default SMTP settings for M365
  db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`,['smtp_host','smtp.office365.com']);
  db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`,['smtp_port','587']);
  db.run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`,['smtp_from_name','KVM Door Systems']);

  saveDb();
  console.log('  ✓ Database seeded with KVM employees');
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname,'public')));
app.use(cors({origin:['http://kvmdoor.com','https://kvmdoor.com','http://www.kvmdoor.com','https://www.kvmdoor.com'],credentials:true}));
app.use(session({secret:'kvm-door-v3-2024',resave:true,saveUninitialized:false,rolling:true,cookie:{maxAge:24*60*60*1000}}));

const requireAuth = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Not authenticated'});
  next();
};
const requireAdmin = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({error:'Not authenticated'});
  // Always re-verify admin status from DB so session loss doesn't cause false denials
  const u = get('SELECT is_admin FROM users WHERE id=?',[req.session.userId]);
  if (!u || !u.is_admin) return res.status(403).json({error:'Admin only'});
  req.session.isAdmin = true; // refresh session flag
  next();
};

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body;
  const user=get('SELECT * FROM users WHERE username=?',[username]);
  if(!user||!bcrypt.compareSync(password,user.password)) return res.status(401).json({error:'Invalid username or password'});
  req.session.userId=user.id; req.session.isAdmin=!!user.is_admin;
  res.json({id:user.id,username:user.username,first_name:user.first_name,last_name:user.last_name,role:user.role,department:user.department,is_admin:!!user.is_admin,avatar_color:user.avatar_color});
});
app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});
app.get('/api/me',requireAuth,(req,res)=>{
  const u=get('SELECT id,username,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,pto_total,pto_left,avatar_color,hire_date FROM users WHERE id=?',[req.session.userId]);
  if(!u) return res.status(404).json({error:'Not found'});
  res.json({...u,is_admin:!!u.is_admin});
});

// ─── USERS ────────────────────────────────────────────────────────────────────
app.get('/api/users',requireAuth,(req,res)=>{
  res.json(all('SELECT id,username,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date FROM users ORDER BY first_name').map(u=>({...u,is_admin:!!u.is_admin})));
});
app.post('/api/users',requireAdmin,(req,res)=>{
  const {username,password,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date}=req.body;
  if(!username||!password||!first_name) return res.status(400).json({error:'Missing required fields'});
  if(get('SELECT id FROM users WHERE username=?',[username])) return res.status(400).json({error:'Username already exists'});
  const id=runGetId(`INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,role_type,pto_total,pto_left,avatar_color,hire_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username,bcrypt.hashSync(password,10),first_name,last_name||'',role||'',department||'',oncall_dept||'',oncall_role||'',paired_with||0,phone||'',email||'',is_admin?1:0,role_type||'technician',pto_total||10,pto_left||10,avatar_color||'#7a5010',hire_date||'']);
  res.json({id});
});
app.put('/api/users/:id', requireManager, (req, res) => {
  const callerUser = get('SELECT is_admin, role_type FROM users WHERE id=?', [req.session.userId]);
  const isAdmin = callerUser && callerUser.is_admin;
  const isManager = callerUser && callerUser.role_type === 'manager';

  if (isAdmin) {
    // Full edit — admin can change everything
    const {first_name,last_name,username,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,pto_total,pto_left,hire_date} = req.body;
    if (!first_name||!username) return res.status(400).json({error:'First name and username are required'});
    const existing = get('SELECT id FROM users WHERE username=? AND id!=?',[username,req.params.id]);
    if (existing) return res.status(400).json({error:'Username already taken'});
    run(`UPDATE users SET first_name=?,last_name=?,username=?,role=?,department=?,oncall_dept=?,oncall_role=?,paired_with=?,phone=?,email=?,is_admin=?,pto_total=?,pto_left=?,hire_date=? WHERE id=?`,
      [first_name,last_name||'',username,role||'',department||'',oncall_dept||'',oncall_role||'',paired_with||0,phone||'',email||'',is_admin?1:0,pto_total||10,pto_left||10,hire_date||'',req.params.id]);
  } else {
    // Manager — limited edit only (no hire_date, PTO, username, is_admin)
    const {first_name,last_name,role,department,oncall_dept,oncall_role,phone,email} = req.body;
    if (!first_name) return res.status(400).json({error:'First name is required'});
    // Managers cannot edit other managers or admins
    const target = get('SELECT is_admin, role_type FROM users WHERE id=?', [req.params.id]);
    if (target && (target.is_admin || target.role_type === 'manager')) {
      return res.status(403).json({error:'Managers cannot edit other managers or admin accounts'});
    }
    const {role_type:mgr_role_type} = req.body;
    run(`UPDATE users SET first_name=?,last_name=?,role=?,department=?,oncall_dept=?,oncall_role=?,phone=?,email=? WHERE id=?`,
      [first_name,last_name||'',role||'',department||'',oncall_dept||'',oncall_role||'',phone||'',email||'',req.params.id]);
  }
  res.json({ok:true});
});
// Change own password
app.put('/api/users/me/password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Missing fields' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = get('SELECT * FROM users WHERE id=?', [req.session.userId]);
  if (!user || !bcrypt.compareSync(current_password, user.password)) return res.status(401).json({ error: 'Current password is incorrect' });
  run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(new_password, 10), req.session.userId]);
  res.json({ ok: true });
});

// Admin reset any user password
app.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'Missing new password' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = get('SELECT id FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(new_password, 10), req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/users/:id',requireAdmin,(req,res)=>{
  if(parseInt(req.params.id)===1) return res.status(403).json({error:'Cannot delete primary admin'});
  run('DELETE FROM users WHERE id=?',[req.params.id]); res.json({ok:true});
});

// ─── ROTATION ─────────────────────────────────────────────────────────────────
app.get('/api/rotation',requireAdmin,(req,res)=>{
  const oh = all(`SELECT r.position, u.id, u.first_name, u.last_name, u.oncall_role, u.phone, u.paired_with
    FROM oncall_rotation r JOIN users u ON r.user_id=u.id WHERE r.department='Overhead Door Division' ORDER BY r.position`);
  const au = all(`SELECT r.position, u.id, u.first_name, u.last_name, u.oncall_role, u.phone
    FROM oncall_rotation r JOIN users u ON r.user_id=u.id WHERE r.department='Automatic Door Division' ORDER BY r.position`);
  res.json({ overhead: oh, automatic: au });
});

app.put('/api/rotation',requireAdmin,(req,res)=>{
  const {department, order} = req.body;
  run('DELETE FROM oncall_rotation WHERE department=?',[department]);
  order.forEach((uid,idx) => db.run('INSERT INTO oncall_rotation (department,user_id,position) VALUES (?,?,?)',[department,uid,idx+1]));
  saveDb();
  res.json({ok:true});
});

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
app.get('/api/announcements',requireAuth,(req,res)=>res.json(all('SELECT * FROM announcements ORDER BY created_at DESC')));
app.post('/api/announcements',requireAdmin,(req,res)=>{
  const {title,body,priority}=req.body; if(!title||!body) return res.status(400).json({error:'Missing fields'});
  const u=get('SELECT first_name,last_name FROM users WHERE id=?',[req.session.userId]);
  res.json({id:runGetId('INSERT INTO announcements (title,body,priority,author_name,created_at) VALUES (?,?,?,?,?)',[title,body,priority||'normal',u.first_name+' '+u.last_name,nowStr()])});
});
app.delete('/api/announcements/:id',requireAdmin,(req,res)=>{run('DELETE FROM announcements WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── NEWS ─────────────────────────────────────────────────────────────────────
app.get('/api/news',requireAuth,(req,res)=>res.json(all('SELECT * FROM news ORDER BY created_at DESC')));
app.post('/api/news',requireAdmin,(req,res)=>{
  const {title,body,category}=req.body; if(!title||!body) return res.status(400).json({error:'Missing fields'});
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

// Swap an on-call employee
app.put('/api/oncall/:id/swap', requireAdmin, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  const user = get('SELECT first_name, last_name, role, phone FROM users WHERE id=?', [user_id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
  run('UPDATE oncall SET name=?, role=?, phone=? WHERE id=?', [name, user.role||'', user.phone||'', req.params.id]);
  res.json({ ok: true });
});

// ─── BLACKOUTS ────────────────────────────────────────────────────────────────
app.get('/api/blackouts',requireAuth,(req,res)=>res.json(all('SELECT * FROM blackouts ORDER BY start_date')));
app.post('/api/blackouts',requireAdmin,(req,res)=>{
  const {label,start_date,end_date}=req.body; if(!label||!start_date||!end_date) return res.status(400).json({error:'Missing fields'});
  res.json({id:runGetId('INSERT INTO blackouts (label,start_date,end_date) VALUES (?,?,?)',[label,start_date,end_date])});
});
app.delete('/api/blackouts/:id',requireAdmin,(req,res)=>{run('DELETE FROM blackouts WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── PTO ─────────────────────────────────────────────────────────────────────
// All approved PTO for calendar view (all users can see approved time off)
app.get('/api/pto/all-approved', requireAuth, (req, res) => {
  res.json(all("SELECT * FROM pto_requests WHERE status='approved' ORDER BY start_date"));
});

app.get('/api/pto',requireAuth,(req,res)=>{
  res.json(req.session.isAdmin ? all('SELECT * FROM pto_requests ORDER BY submitted_at DESC') : all('SELECT * FROM pto_requests WHERE user_id=? ORDER BY submitted_at DESC',[req.session.userId]));
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
app.get('/api/settings',requireAdmin,(req,res)=>{ const s=getSettings(); delete s.smtp_pass; delete s.gcal_key; res.json(s); });

// Test email
app.post('/api/settings/test-email', requireAdmin, async (req,res) => {
  const settings = getSettings();
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
    return res.status(400).json({ error: 'Email settings not configured. Please save your SMTP settings first.' });
  }
  const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const cron = require('node-cron');
  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: parseInt(settings.smtp_port)||587,
      secure: false,
      auth: { user: settings.smtp_user, pass: settings.smtp_pass },
      tls: { rejectUnauthorized: false }
    });
    const user = get('SELECT email, first_name FROM users WHERE id=?', [req.session.userId]);
    const toEmail = user && user.email ? user.email : settings.smtp_user;
    await transporter.sendMail({
      from: '"' + (settings.smtp_from_name||'KVM Door Systems') + '" <' + settings.smtp_user + '>',
      to: toEmail,
      subject: 'KVM Portal — Test Email',
      html: '<div style="font-family:Arial,sans-serif;padding:20px"><h2 style="color:#F5A623">KVM Door Systems Portal</h2><p>This is a test email confirming your email notifications are working correctly.</p><p style="color:#888;font-size:12px">Sent from KVM Employee Portal</p></div>'
    });
    res.json({ ok: true, sent_to: toEmail });
  } catch(e) {
    res.status(500).json({ error: 'Email failed: ' + e.message });
  }
});
app.post('/api/settings',requireAdmin,(req,res)=>{
  ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from_name','gcal_id','gcal_key'].forEach(k=>{
    if(req.body[k]!==undefined){ if(get('SELECT key FROM settings WHERE key=?',[k])) run('UPDATE settings SET value=? WHERE key=?',[req.body[k],k]); else run('INSERT INTO settings (key,value) VALUES (?,?)',[k,req.body[k]]); }
  });
  res.json({ok:true});
});


// Seed current on-call schedule from KVM's paper list
app.post('/api/oncall/seed-schedule', requireAdmin, (req, res) => {
  // Clear existing future entries first
  const today = new Date().toISOString().split('T')[0];
  run('DELETE FROM oncall WHERE start_date >= ?', [today]);

  // KVM schedule from paper list (3/21 onwards)
  // Format: [start, end, OH1_username, OH2_username, AD_username]
  const schedule = [
    ['2026-03-21','2026-03-27','mike.l',    'robert.jr', 'scott.evans'],
    ['2026-03-28','2026-04-03','steve.winter','jermiah',  'skyler'],
    ['2026-04-04','2026-04-10','sherman',   'emmet',     'k.berry'],
    ['2026-04-11','2026-04-17','lorne',     'derek',     'rob.s'],
    ['2026-04-18','2026-04-24','mjr',       'sean.mccann','scott.evans'],
    ['2026-04-25','2026-05-01','k.shaw',    'anthony',   'skyler'],
    ['2026-05-02','2026-05-08','mike.l',    'robert.jr', 'k.berry'],
    ['2026-05-09','2026-05-15','mark.todd', 'jermiah',   'scott.evans'],
    ['2026-05-16','2026-05-22','steve.winter','derek',   'rob.s'],
    ['2026-05-23','2026-05-29','sherman',   'emmet',     'skyler'],
    ['2026-05-30','2026-06-05','mjr',       'sean.mccann','k.berry'],
    ['2026-06-06','2026-06-12','lorne',     'anthony',   'scott.evans'],
    ['2026-06-13','2026-06-19','mike.l',    'robert.jr', 'rob.s'],
  ];

  let created = 0;
  schedule.forEach(([start, end, oh1un, oh2un, adun]) => {
    const oh1 = get('SELECT first_name,last_name,role,phone FROM users WHERE username=?',[oh1un]);
    const oh2 = get('SELECT first_name,last_name,role,phone FROM users WHERE username=?',[oh2un]);
    const ad  = get('SELECT first_name,last_name,role,phone FROM users WHERE username=?',[adun]);
    const mkName = u => u ? u.first_name+(u.last_name?' '+u.last_name:'') : null;
    if (oh1) { db.run('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[mkName(oh1),oh1.role||'',oh1.phone||'','Overhead Door Division',start,end]); created++; }
    if (oh2) { db.run('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[mkName(oh2),oh2.role||'',oh2.phone||'','Overhead Door Division',start,end]); created++; }
    if (ad)  { db.run('INSERT INTO oncall (name,role,phone,department,start_date,end_date) VALUES (?,?,?,?,?,?)',[mkName(ad), ad.role||'', ad.phone||'', 'Automatic Door Division',start,end]); created++; }
  });
  saveDb();
  res.json({ ok: true, created, message: `Loaded ${schedule.length} weeks, ${created} entries` });
});


// ─── EMPLOYEE DOCUMENTS ────────────────────────────────────────────────────────
app.get('/api/docs/my', requireAuth, (req, res) => {
  const docs = all('SELECT id,user_id,user_name,doc_name,doc_type,expiry_date,notes,file_name,file_type,file_size,uploaded_at FROM employee_docs WHERE user_id=? ORDER BY uploaded_at DESC', [req.session.userId]);
  res.json(docs);
});

app.get('/api/docs/all', requireAdmin, (req, res) => {
  const docs = all('SELECT id,user_id,user_name,doc_name,doc_type,expiry_date,notes,file_name,file_type,file_size,uploaded_at FROM employee_docs ORDER BY user_name,uploaded_at DESC');
  res.json(docs);
});

app.get('/api/docs/:id/download', requireAuth, (req, res) => {
  const doc = get('SELECT * FROM employee_docs WHERE id=?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  // Only owner or admin can download
  const isAdmin = !!(get('SELECT is_admin FROM users WHERE id=?', [req.session.userId]) || {}).is_admin;
  if (doc.user_id !== req.session.userId && !isAdmin) return res.status(403).json({ error: 'Access denied' });
  const buf = Buffer.from(doc.file_data, 'base64');
  res.setHeader('Content-Type', doc.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + doc.file_name + '"');
  res.send(buf);
});

app.post('/api/docs', requireAuth, (req, res) => {
  const { doc_name, doc_type, expiry_date, notes, file_name, file_data, file_type, file_size } = req.body;
  if (!doc_name || !file_data) return res.status(400).json({ error: 'Missing document name or file' });
  if (file_size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 5MB)' });
  const u = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const user_name = u.first_name + (u.last_name ? ' ' + u.last_name : '');
  const id = runGetId('INSERT INTO employee_docs (user_id,user_name,doc_name,doc_type,expiry_date,notes,file_name,file_data,file_type,file_size) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.session.userId, user_name, doc_name, doc_type||'other', expiry_date||'', notes||'', file_name||'', file_data, file_type||'', file_size||0]);
  res.json({ id });
});

app.delete('/api/docs/:id', requireAuth, (req, res) => {
  const doc = get('SELECT user_id FROM employee_docs WHERE id=?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const isAdmin = !!(get('SELECT is_admin FROM users WHERE id=?', [req.session.userId]) || {}).is_admin;
  if (doc.user_id !== req.session.userId && !isAdmin) return res.status(403).json({ error: 'Access denied' });
  run('DELETE FROM employee_docs WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── COMPANY POLICIES ──────────────────────────────────────────────────────────
app.get('/api/policies', requireAuth, (req, res) => {
  const rows = all('SELECT id,title,category,description,file_name,file_type,file_size,uploaded_by,uploaded_at FROM company_policies ORDER BY category,uploaded_at DESC');
  res.json(rows);
});

app.get('/api/policies/:id/download', requireAuth, (req, res) => {
  const doc = get('SELECT * FROM company_policies WHERE id=?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const buf = Buffer.from(doc.file_data, 'base64');
  res.setHeader('Content-Type', doc.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + doc.file_name + '"');
  res.send(buf);
});

app.post('/api/policies', requireAdmin, (req, res) => {
  const { title, category, description, file_name, file_data, file_type, file_size } = req.body;
  if (!title || !file_data) return res.status(400).json({ error: 'Missing title or file' });
  if (file_size > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 10MB)' });
  const u = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const uploaded_by = u.first_name + (u.last_name ? ' ' + u.last_name : '');
  const id = runGetId('INSERT INTO company_policies (title,category,description,file_name,file_data,file_type,file_size,uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
    [title, category||'other', description||'', file_name||'', file_data, file_type||'', file_size||0, uploaded_by]);
  res.json({ id });
});

app.delete('/api/policies/:id', requireAdmin, (req, res) => {
  run('DELETE FROM company_policies WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});


// ─── TIMECLOCK ────────────────────────────────────────────────────────────────
const OFFICE_DEPARTMENTS = ['Management','Executives','Executive','Office','Office Staff','Sales','Admin','Administration'];
const SHOP_LAT  = 42.55514;
const SHOP_LNG  = -82.866313;
const GEOFENCE_RADIUS_FT = 500;
const GEOFENCE_RADIUS_M  = GEOFENCE_RADIUS_FT * 0.3048; // 152.4 meters

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function calcMinutes(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0;
  return Math.round((new Date(clockOut) - new Date(clockIn)) / 60000);
}

// Get current clock status for user
app.get('/api/timeclock/status', requireAuth, (req, res) => {
  const active = get('SELECT * FROM timeclock WHERE user_id=? AND status=? ORDER BY clock_in DESC LIMIT 1', [req.session.userId, 'in']);
  res.json({ clocked_in: !!active, entry: active || null });
});

// Clock in
app.post('/api/timeclock/in', requireAuth, (req, res) => {
  const { latitude, longitude, clock_type, job_name, customer_name, notes, is_union, is_offsite } = req.body;
  // Check not already clocked in
  const active = get('SELECT id FROM timeclock WHERE user_id=? AND status=?', [req.session.userId, 'in']);
  if (active) return res.status(400).json({ error: 'Already clocked in. Please clock out first.' });
  const u = get('SELECT first_name, last_name FROM users WHERE id=?', [req.session.userId]);
  const user_name = u.first_name + (u.last_name ? ' ' + u.last_name : '');
  const now = new Date().toISOString();
  const week_start = getWeekStart(now.split('T')[0]);
  const id = runGetId(`INSERT INTO timeclock (user_id, user_name, clock_type, status, clock_in, latitude_in, longitude_in, job_name, customer_name, notes, is_union, is_offsite, week_start) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.session.userId, user_name, clock_type||'shop', 'in', now, latitude||null, longitude||null, job_name||'', customer_name||'', notes||'', is_union?1:0, is_offsite?1:0, week_start]);
  // Check and record tardiness
  checkTardiness(req.session.userId, user_name, now);
  res.json({ id, clock_in: now });
});

// Clock out
app.post('/api/timeclock/out', requireAuth, (req, res) => {
  const { latitude, longitude, notes } = req.body;
  const active = get('SELECT * FROM timeclock WHERE user_id=? AND status=?', [req.session.userId, 'in']);
  if (!active) return res.status(400).json({ error: 'Not currently clocked in.' });
  const now = new Date().toISOString();
  const total_minutes = calcMinutes(active.clock_in, now);
  run('UPDATE timeclock SET status=?, clock_out=?, latitude_out=?, longitude_out=?, total_minutes=? WHERE id=?',
    ['out', now, latitude||null, longitude||null, total_minutes, active.id]);
  res.json({ ok: true, clock_out: now, total_minutes });
});

// Log geofence alert (called from frontend when user enters/leaves without clocking)
app.post('/api/timeclock/alert', requireAuth, (req, res) => {
  const { alert_type, latitude, longitude } = req.body;
  const u = get('SELECT first_name, last_name FROM users WHERE id=?', [req.session.userId]);
  const user_name = u.first_name + (u.last_name ? ' ' + u.last_name : '');
  runGetId('INSERT INTO geofence_alerts (user_id, user_name, alert_type, latitude, longitude) VALUES (?,?,?,?,?)',
    [req.session.userId, user_name, alert_type, latitude||null, longitude||null]);
  res.json({ ok: true });
});

// My timecard entries
app.get('/api/timeclock/my', requireAuth, (req, res) => {
  const { week } = req.query;
  let entries;
  if (week) {
    const weekEnd = new Date(week + 'T00:00:00'); weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];
    entries = all('SELECT * FROM timeclock WHERE user_id=? AND week_start=? ORDER BY clock_in DESC', [req.session.userId, week]);
  } else {
    entries = all('SELECT * FROM timeclock WHERE user_id=? ORDER BY clock_in DESC LIMIT 50', [req.session.userId]);
  }
  res.json(entries);
});

// Admin: all timeclock entries
app.get('/api/timeclock/all', requireAdmin, (req, res) => {
  const { week } = req.query;
  let entries;
  if (week) {
    entries = all('SELECT * FROM timeclock WHERE week_start=? ORDER BY user_name, clock_in', [week]);
  } else {
    const thisWeek = getWeekStart(new Date().toISOString().split('T')[0]);
    entries = all('SELECT * FROM timeclock WHERE week_start=? ORDER BY user_name, clock_in', [thisWeek]);
  }
  res.json(entries);
});

// Admin: weekly summary (for timecard emails)
app.get('/api/timeclock/summary', requireAdmin, (req, res) => {
  const { week } = req.query || {};
  const targetWeek = week || getWeekStart(new Date().toISOString().split('T')[0]);
  const entries = all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name, clock_in', [targetWeek, 'out']);
  
  // Group by user
  const summary = {};
  entries.forEach(e => {
    if (!summary[e.user_id]) {
      summary[e.user_id] = { user_name: e.user_name, total_minutes: 0, entries: [], overtime_minutes: 0, is_union: !!e.is_union };
    }
    summary[e.user_id].total_minutes += e.total_minutes || 0;
    summary[e.user_id].entries.push(e);
  });
  
  // Calculate overtime (over 40hrs/week = 2400 mins)
  Object.values(summary).forEach(u => {
    u.overtime_minutes = Math.max(0, u.total_minutes - 2400);
    u.regular_minutes = Math.min(u.total_minutes, 2400);
    u.total_hours = (u.total_minutes / 60).toFixed(2);
    u.overtime_hours = (u.overtime_minutes / 60).toFixed(2);
    u.regular_hours = (u.regular_minutes / 60).toFixed(2);
  });
  
  res.json({ week: targetWeek, summary: Object.values(summary) });
});

// Admin: geofence alerts
app.get('/api/timeclock/alerts', requireAdmin, (req, res) => {
  res.json(all('SELECT * FROM geofence_alerts WHERE resolved=0 ORDER BY created_at DESC'));
});

app.put('/api/timeclock/alerts/:id/resolve', requireAdmin, (req, res) => {
  run('UPDATE geofence_alerts SET resolved=1 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// Admin: manual edit timecard entry
app.put('/api/timeclock/:id', requireAdmin, (req, res) => {
  const { clock_in, clock_out, job_name, notes } = req.body;
  const entry = get('SELECT * FROM timeclock WHERE id=?', [req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const total_minutes = calcMinutes(clock_in || entry.clock_in, clock_out || entry.clock_out);
  const week_start = getWeekStart((clock_in || entry.clock_in).split('T')[0]);
  run('UPDATE timeclock SET clock_in=?, clock_out=?, job_name=?, notes=?, total_minutes=?, week_start=?, status=? WHERE id=?',
    [clock_in || entry.clock_in, clock_out || entry.clock_out, job_name || entry.job_name, notes || entry.notes, total_minutes, week_start, clock_out ? 'out' : entry.status, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/timeclock/:id', requireAdmin, (req, res) => {
  run('DELETE FROM timeclock WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// Send weekly timecard emails
app.post('/api/timeclock/send-timecards', requireAdmin, async (req, res) => {
  const { week } = req.body;
  const targetWeek = week || getWeekStart(new Date().toISOString().split('T')[0]);
  const settings = getSettings();
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
    return res.status(400).json({ error: 'Email not configured in Portal Settings' });
  }
  const entries = all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name, clock_in', [targetWeek, 'out']);
  
  // Group by user
  const byUser = {};
  entries.forEach(e => {
    if (!byUser[e.user_id]) byUser[e.user_id] = { name: e.user_name, entries: [], total: 0 };
    byUser[e.user_id].entries.push(e);
    byUser[e.user_id].total += e.total_minutes || 0;
  });

  const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const cron = require('node-cron');
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host, port: parseInt(settings.smtp_port)||587,
    secure: false, auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    tls: { rejectUnauthorized: false }
  });

  let sent = 0;
  for (const [uid, data] of Object.entries(byUser)) {
    const user = get('SELECT email FROM users WHERE id=?', [uid]);
    if (!user || !user.email) continue;
    const hrs = (data.total / 60).toFixed(2);
    const ot = Math.max(0, data.total - 2400);
    const otHrs = (ot / 60).toFixed(2);
    const rows = data.entries.map(e => `<tr><td style="padding:6px 10px;border-bottom:1px solid #333">${new Date(e.clock_in).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${new Date(e.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${e.clock_out ? new Date(e.clock_out).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '—'}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${((e.total_minutes||0)/60).toFixed(2)} hrs</td><td style="padding:6px 10px;border-bottom:1px solid #333">${e.clock_type}${e.is_union?' (Union)':''}</td><td style="padding:6px 10px;border-bottom:1px solid #333">${e.job_name||'—'}</td></tr>`).join('');
    const html = `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px;background:#fff"><h2 style="color:#F5A623">Weekly Timecard — ${data.name}</h2><p>Week of: <strong>${targetWeek}</strong></p><table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px"><thead><tr style="background:#f0f0f0"><th style="padding:8px 10px;text-align:left">Date</th><th style="padding:8px 10px;text-align:left">In</th><th style="padding:8px 10px;text-align:left">Out</th><th style="padding:8px 10px;text-align:left">Hours</th><th style="padding:8px 10px;text-align:left">Type</th><th style="padding:8px 10px;text-align:left">Job</th></tr></thead><tbody>${rows}</tbody></table><div style="background:#f9f9f9;padding:12px;border-radius:6px;margin-top:12px"><strong>Regular Hours:</strong> ${Math.min(parseFloat(hrs),40).toFixed(2)} | <strong>Overtime Hours:</strong> <span style="color:${ot>0?'#c0392b':'#27ae60'}">${otHrs}</span> | <strong>Total Hours:</strong> ${hrs}</div><hr style="margin:20px 0;border:none;border-top:1px solid #eee"/><p style="font-size:12px;color:#999">KVM Door Systems Employee Portal — This is your official timecard for the week. Contact your manager if you see any discrepancies.</p></div></div>`;
    try {
      await transporter.sendMail({ from: '"KVM Door Systems" <' + settings.smtp_user + '>', to: user.email, subject: 'Weekly Timecard — ' + data.name + ' — Week of ' + targetWeek, html });
      sent++;
    } catch(e) { console.error('Timecard email failed for', data.name, e.message); }
  }
  res.json({ ok: true, sent, total: Object.keys(byUser).length });
});


// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SHIFT_START_HOUR   = 6;   // 6:00 AM
const SHIFT_START_MIN    = 0;
const TARDY_GRACE_MINS   = 15;  // grace period before tardy
const CALLIN_TYPES = ['Sick','Personal','No Call No Show','FMLA','Bereavement','Union Leave','Approved Absence'];

function getQuarter(dateStr) {
  const m = parseInt(dateStr.split('-')[1]);
  return m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
}

function getQuarterStart(quarter, year) {
  const starts = { Q1:`${year}-01-01`, Q2:`${year}-04-01`, Q3:`${year}-07-01`, Q4:`${year}-10-01` };
  return starts[quarter];
}

function getQuarterEnd(quarter, year) {
  const ends = { Q1:`${year}-03-31`, Q2:`${year}-06-30`, Q3:`${year}-09-30`, Q4:`${year}-12-31` };
  return ends[quarter];
}

// Check and record tardiness when employee clocks in
function checkTardiness(userId, userName, clockInTime) {
  const d = new Date(clockInTime);
  const dateStr = d.toISOString().split('T')[0];
  const shiftStart = new Date(dateStr + 'T0' + SHIFT_START_HOUR + ':' + String(SHIFT_START_MIN).padStart(2,'0') + ':00');
  const minutesLate = Math.floor((d - shiftStart) / 60000);
  if (minutesLate > TARDY_GRACE_MINS) {
    const existing = get('SELECT id FROM attendance WHERE user_id=? AND event_date=? AND event_type=?', [userId, dateStr, 'tardy']);
    if (!existing) {
      const quarter = getQuarter(dateStr);
      const year = parseInt(dateStr.split('-')[0]);
      runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,minutes_late,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?,?)',
        [userId, userName, dateStr, 'tardy', minutesLate, `Clocked in ${minutesLate} minutes late`, 'system', quarter, year]);
      console.log(`  Tardy recorded: ${userName} — ${minutesLate} mins late on ${dateStr}`);
    }
  }
}

// Override clock-in to check tardiness
const _origClockIn = app._router.stack.find(r => r.route && r.route.path === '/api/timeclock/in');

// ─── ATTENDANCE ROUTES ────────────────────────────────────────────────────────
// Get my attendance summary
app.get('/api/attendance/my', requireAuth, (req, res) => {
  const year = new Date().getFullYear();
  const quarter = getQuarter(new Date().toISOString().split('T')[0]);
  const qStart = getQuarterStart(quarter, year);
  const qEnd = getQuarterEnd(quarter, year);
  const events = all('SELECT * FROM attendance WHERE user_id=? ORDER BY event_date DESC', [req.session.userId]);
  const callins = all('SELECT * FROM callins WHERE user_id=? ORDER BY call_in_date DESC', [req.session.userId]);
  const thisQEvents = events.filter(e => e.event_date >= qStart && e.event_date <= qEnd);
  const thisQCallins = callins.filter(c => c.call_in_date >= qStart && c.call_in_date <= qEnd);
  const recognition = all('SELECT * FROM attendance_recognition WHERE user_id=? ORDER BY year DESC, quarter DESC', [req.session.userId]);
  res.json({ events, callins, thisQEvents, thisQCallins, recognition, quarter, year });
});

// Admin: get all attendance
app.get('/api/attendance/all', requireAdmin, (req, res) => {
  const { quarter, year } = req.query;
  let events, callins;
  if (quarter && year) {
    const qStart = getQuarterStart(quarter, parseInt(year));
    const qEnd = getQuarterEnd(quarter, parseInt(year));
    events = all('SELECT * FROM attendance WHERE event_date>=? AND event_date<=? ORDER BY user_name,event_date', [qStart, qEnd]);
    callins = all('SELECT * FROM callins WHERE call_in_date>=? AND call_in_date<=? ORDER BY user_name,call_in_date', [qStart, qEnd]);
  } else {
    events = all('SELECT * FROM attendance ORDER BY event_date DESC LIMIT 500');
    callins = all('SELECT * FROM callins ORDER BY call_in_date DESC LIMIT 200');
  }
  res.json({ events, callins });
});

// Admin: quarterly report
app.get('/api/attendance/report', requireAdmin, (req, res) => {
  const { quarter, year } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const q = quarter || getQuarter(new Date().toISOString().split('T')[0]);
  const qStart = getQuarterStart(q, y);
  const qEnd   = getQuarterEnd(q, y);

  const users = all('SELECT id,first_name,last_name,role,department FROM users WHERE is_admin=0 ORDER BY first_name');
  const events = all('SELECT * FROM attendance WHERE event_date>=? AND event_date<=?', [qStart, qEnd]);
  const callins = all('SELECT * FROM callins WHERE call_in_date>=? AND call_in_date<=?', [qStart, qEnd]);
  const recognition = all('SELECT * FROM attendance_recognition WHERE quarter=? AND year=?', [q, y]);

  const report = users.map(u => {
    const uEvents  = events.filter(e => e.user_id === u.id);
    const uCallins = callins.filter(c => c.user_id === u.id);
    const tardies = uEvents.filter(e => e.event_type === 'tardy');
    const absences = uEvents.filter(e => e.event_type === 'absence');
    const earlyDepartures = uEvents.filter(e => e.event_type === 'early_departure');
    const ncns = uCallins.filter(c => c.call_in_type === 'No Call No Show');
    const isPerfect = tardies.length === 0 && uCallins.length === 0 && absences.length === 0;
    const hasRecognition = recognition.some(r => r.user_id === u.id);
    return {
      user_id: u.id, name: u.first_name + (u.last_name?' '+u.last_name:''),
      role: u.role, department: u.department,
      tardies: tardies.length, callins: uCallins.length,
      absences: absences.length, early_departures: earlyDepartures.length,
      ncns: ncns.length, is_perfect: isPerfect, recognized: hasRecognition,
      tardy_details: tardies, callin_details: uCallins
    };
  });

  res.json({ quarter: q, year: y, qStart, qEnd, report });
});

// Admin: log call-in
app.post('/api/attendance/callin', requireAdmin, async (req, res) => {
  const { user_id, call_in_date, call_in_type, notes } = req.body;
  if (!user_id || !call_in_date || !call_in_type) return res.status(400).json({ error: 'Missing fields' });
  const user = get('SELECT first_name,last_name,email FROM users WHERE id=?', [user_id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const user_name = user.first_name + (user.last_name?' '+user.last_name:'');
  const admin = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const admin_name = admin.first_name + (admin.last_name?' '+admin.last_name:'');
  const id = runGetId('INSERT INTO callins (user_id,user_name,call_in_date,call_in_type,notes,logged_by) VALUES (?,?,?,?,?,?)',
    [user_id, user_name, call_in_date, call_in_type, notes||'', admin_name]);

  // Also log in attendance table
  const quarter = getQuarter(call_in_date);
  const year = parseInt(call_in_date.split('-')[0]);
  runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?)',
    [user_id, user_name, call_in_date, 'callin', call_in_type + (notes?' — '+notes:''), admin_name, quarter, year]);

  // Email notification to employee
  const settings = getSettings();
  if (user.email && settings.smtp_host && settings.smtp_user && settings.smtp_pass) {
    try {
      const transporter = nodemailer.createTransport({ host:settings.smtp_host, port:parseInt(settings.smtp_port)||587, secure:false, auth:{user:settings.smtp_user,pass:settings.smtp_pass}, tls:{rejectUnauthorized:false} });
      const html = `<div style="font-family:Arial,sans-serif;max-width:500px"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623">Attendance Record — ${call_in_type}</h2><p>Hi ${user.first_name},</p><p>This is to confirm that <strong>${call_in_type}</strong> has been logged for you on <strong>${call_in_date}</strong>.</p>${notes?`<p><em>Notes: ${notes}</em></p>`:''}<p>If you have questions, please contact your manager.</p><hr style="border:none;border-top:1px solid #eee;margin:20px 0"/><p style="font-size:12px;color:#999">KVM Door Systems Employee Portal</p></div></div>`;
      await transporter.sendMail({ from:'"KVM Door Systems" <'+settings.smtp_user+'>', to:user.email, subject:`Attendance Logged — ${call_in_type} — ${call_in_date}`, html });
      run('UPDATE callins SET notified=1 WHERE id=?', [id]);
    } catch(e) { console.error('Call-in email error:', e.message); }
  }
  res.json({ id });
});

// Admin: manual attendance event (absence, early departure)
app.post('/api/attendance/event', requireAdmin, (req, res) => {
  const { user_id, event_date, event_type, minutes_late, notes } = req.body;
  if (!user_id || !event_date || !event_type) return res.status(400).json({ error: 'Missing fields' });
  const user = get('SELECT first_name,last_name FROM users WHERE id=?', [user_id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const user_name = user.first_name + (user.last_name?' '+user.last_name:'');
  const admin = get('SELECT first_name,last_name FROM users WHERE id=?', [req.session.userId]);
  const admin_name = admin.first_name + (admin.last_name?' '+admin.last_name:'');
  const quarter = getQuarter(event_date);
  const year = parseInt(event_date.split('-')[0]);
  const id = runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,minutes_late,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?,?)',
    [user_id, user_name, event_date, event_type, minutes_late||0, notes||'', admin_name, quarter, year]);
  res.json({ id });
});

app.delete('/api/attendance/:id', requireAdmin, (req, res) => {
  run('DELETE FROM attendance WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/attendance/callin/:id', requireAdmin, (req, res) => {
  run('DELETE FROM callins WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── PERFECT ATTENDANCE RECOGNITION ──────────────────────────────────────────
async function checkPerfectAttendance(quarter, year) {
  const qStart = getQuarterStart(quarter, year);
  const qEnd   = getQuarterEnd(quarter, year);
  const users  = all('SELECT id,first_name,last_name FROM users WHERE is_admin=0');
  const events  = all('SELECT user_id FROM attendance WHERE event_date>=? AND event_date<=?', [qStart, qEnd]);
  const callins = all('SELECT user_id FROM callins WHERE call_in_date>=? AND call_in_date<=?', [qStart, qEnd]);
  const eventUsers  = new Set(events.map(e => e.user_id));
  const callinUsers = new Set(callins.map(c => c.user_id));
  const perfectEmployees = users.filter(u => !eventUsers.has(u.id) && !callinUsers.has(u.id));

  if (!perfectEmployees.length) return;

  // Record recognition and make announcement
  const names = perfectEmployees.map(u => u.first_name + (u.last_name?' '+u.last_name:'')).join(', ');
  const body = `Congratulations to the following employees for achieving Perfect Attendance in ${quarter} ${year}! Your dedication and reliability are what make KVM Door Systems great. 🏆

${names}`;

  // Add to announcements
  const existing = get('SELECT id FROM attendance_recognition WHERE quarter=? AND year=? AND announced=1', [quarter, year]);
  if (!existing) {
    runGetId('INSERT INTO announcements (title,body,priority,author_name,created_at) VALUES (?,?,?,?,?)',
      [`🏆 Perfect Attendance — ${quarter} ${year}`, body, 'info', 'KVM Door Systems', new Date().toISOString().replace('T',' ').split('.')[0]]);
    perfectEmployees.forEach(u => {
      const alreadyRecognized = get('SELECT id FROM attendance_recognition WHERE user_id=? AND quarter=? AND year=?', [u.id, quarter, year]);
      if (!alreadyRecognized) {
        runGetId('INSERT INTO attendance_recognition (user_id,user_name,quarter,year,announced) VALUES (?,?,?,?,1)',
          [u.id, u.first_name+(u.last_name?' '+u.last_name:''), quarter, year, 1]);
      }
    });
    console.log(`  Perfect attendance announced for ${quarter} ${year}: ${names}`);
  }
}

// ─── EXCEL EXPORT ─────────────────────────────────────────────────────────────
function buildTimecardExcel(week) {
  const entries = all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name, clock_in', [week, 'out']);
  const users = all('SELECT id,first_name,last_name,role,department FROM users WHERE is_admin=0 ORDER BY first_name');
  const wb = XLSX.utils.book_new();

  // Master summary sheet
  const summaryData = [['Employee','Role','Department','Regular Hours','Overtime Hours','Total Hours','Tardies','Call-Ins','Week']];
  const byUser = {};
  entries.forEach(e => {
    if (!byUser[e.user_id]) byUser[e.user_id] = { name:e.user_name, mins:0, entries:[] };
    byUser[e.user_id].mins += e.total_minutes || 0;
    byUser[e.user_id].entries.push(e);
  });

  const qStart = getWeekStart(week);
  users.forEach(u => {
    const ud = byUser[u.id];
    const totalMins = ud ? ud.mins : 0;
    const regularMins = Math.min(totalMins, 2400);
    const otMins = Math.max(0, totalMins - 2400);
    const tardies = all('SELECT COUNT(*) as c FROM attendance WHERE user_id=? AND event_type=? AND event_date>=? AND event_date<=?', [u.id, 'tardy', week, addDaysServer(week,6)])[0]?.c || 0;
    const callins = all('SELECT COUNT(*) as c FROM callins WHERE user_id=? AND call_in_date>=? AND call_in_date<=?', [u.id, week, addDaysServer(week,6)])[0]?.c || 0;
    summaryData.push([
      u.first_name+(u.last_name?' '+u.last_name:''),
      u.role||'', u.department||'',
      (regularMins/60).toFixed(2), (otMins/60).toFixed(2), (totalMins/60).toFixed(2),
      tardies, callins, week
    ]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Weekly Summary');

  // Individual sheet per employee
  users.forEach(u => {
    const ud = byUser[u.id];
    const sheetData = [['Date','Day','Clock In','Clock Out','Hours','Type','Job Name','Notes']];
    if (ud) {
      ud.entries.forEach(e => {
        const d = new Date(e.clock_in);
        sheetData.push([
          d.toLocaleDateString('en-US'),
          d.toLocaleDateString('en-US',{weekday:'long'}),
          new Date(e.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}),
          e.clock_out ? new Date(e.clock_out).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : 'Active',
          ((e.total_minutes||0)/60).toFixed(2),
          e.clock_type + (e.is_union?' (Union)':''),
          e.job_name||'',
          e.notes||''
        ]);
      });
    }
    const safeName = (u.first_name+(u.last_name?' '+u.last_name:'')).replace(/[:\/?*\[\]]/g,'').slice(0,31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData), safeName);
  });

  return wb;
}

function addDaysServer(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0];
}

// Manual export endpoint
app.get('/api/timeclock/export', requireAdmin, (req, res) => {
  const { week } = req.query;
  const targetWeek = week || getWeekStart(new Date().toISOString().split('T')[0]);
  try {
    const wb = buildTimecardExcel(targetWeek);
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="KVM_Timecards_${targetWeek}.xlsx"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────
// Every Monday at 6:00 AM — generate last week's timecard Excel and email to admin
cron.schedule('0 6 * * 1', async () => {
  console.log('  Running weekly timecard export...');
  const today = new Date().toISOString().split('T')[0];
  const lastMonday = new Date(today + 'T00:00:00');
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastWeek = lastMonday.toISOString().split('T')[0];

  try {
    const wb = buildTimecardExcel(lastWeek);
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    const settings = getSettings();
    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) return;

    const adminEmails = all("SELECT email FROM users WHERE is_admin=1 AND email!=''").map(u=>u.email);
    if (!adminEmails.length) return;

    const transporter = nodemailer.createTransport({ host:settings.smtp_host, port:parseInt(settings.smtp_port)||587, secure:false, auth:{user:settings.smtp_user, pass:settings.smtp_pass}, tls:{rejectUnauthorized:false} });
    await transporter.sendMail({
      from: '"KVM Door Systems" <'+settings.smtp_user+'>',
      to: adminEmails.join(','),
      subject: `KVM Weekly Timecards — Week of ${lastWeek}`,
      html: `<div style="font-family:Arial,sans-serif"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623">Weekly Timecard Report</h2><p>Attached is the timecard Excel file for the week of <strong>${lastWeek}</strong>.</p><p>The file contains a summary sheet and individual tabs for each employee. Save this to your master timecard file.</p></div></div>`,
      attachments: [{ filename: `KVM_Timecards_${lastWeek}.xlsx`, content: buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
    });
    console.log('  Weekly timecard Excel sent to:', adminEmails.join(', '));

    // Also send individual timecards to each employee
    const entries = all('SELECT * FROM timeclock WHERE week_start=? AND status=? ORDER BY user_name,clock_in', [lastWeek,'out']);
    const byUser = {};
    entries.forEach(e => { if(!byUser[e.user_id]) byUser[e.user_id]={name:e.user_name,entries:[],total:0}; byUser[e.user_id].entries.push(e); byUser[e.user_id].total+=e.total_minutes||0; });
    for (const [uid,data] of Object.entries(byUser)) {
      const user = get('SELECT email,first_name FROM users WHERE id=?',[uid]);
      if (!user || !user.email) continue;
      const hrs=(data.total/60).toFixed(2);
      const ot=Math.max(0,data.total-2400);
      const rows=data.entries.map(e=>`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${new Date(e.clock_in).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${new Date(e.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${e.clock_out?new Date(e.clock_out).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'—'}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${((e.total_minutes||0)/60).toFixed(2)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${e.clock_type}${e.is_union?' (Union)':''}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${e.job_name||'—'}</td></tr>`).join('');
      const html=`<div style="font-family:Arial,sans-serif;max-width:700px"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623">Your Timecard — Week of ${lastWeek}</h2><p>Hi ${user.first_name},</p><table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0"><thead><tr style="background:#f0f0f0"><th style="padding:8px 10px;text-align:left">Date</th><th style="padding:8px 10px;text-align:left">In</th><th style="padding:8px 10px;text-align:left">Out</th><th style="padding:8px 10px;text-align:left">Hours</th><th style="padding:8px 10px;text-align:left">Type</th><th style="padding:8px 10px;text-align:left">Job</th></tr></thead><tbody>${rows}</tbody></table><div style="background:#f9f9f9;padding:12px;border-radius:6px"><strong>Regular:</strong> ${(Math.min(data.total,2400)/60).toFixed(2)} hrs | <strong>Overtime:</strong> <span style="color:${ot>0?'#c0392b':'#27ae60'}">${(ot/60).toFixed(2)} hrs</span> | <strong>Total:</strong> ${hrs} hrs</div><hr style="border:none;border-top:1px solid #eee;margin:20px 0"/><p style="font-size:12px;color:#999">KVM Door Systems Employee Portal — Contact your manager if you see any discrepancies.</p></div></div>`;
      try { await transporter.sendMail({ from:'"KVM Door Systems" <'+settings.smtp_user+'>', to:user.email, subject:`Your Timecard — Week of ${lastWeek}`, html }); } catch(e2){}
    }
  } catch(e) { console.error('Weekly export error:', e.message); }
}, { timezone: 'America/Detroit' });

// Quarterly perfect attendance check — runs on Jan 1, Apr 1, Jul 1, Oct 1 at 7:00 AM
cron.schedule('0 7 1 1,4,7,10 *', async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const prevQuarters = { 1:'Q4', 4:'Q1', 7:'Q2', 10:'Q3' };
  const prevYears    = { 1:year-1, 4:year, 7:year, 10:year };
  const q = prevQuarters[month];
  const y = prevYears[month];
  if (q && y) {
    console.log(`  Checking perfect attendance for ${q} ${y}...`);
    await checkPerfectAttendance(q, y);
  }
}, { timezone: 'America/Detroit' });

// ─── DAILY ATTENDANCE EMAIL ───────────────────────────────────────────────────
async function sendDailyAttendanceEmail(group) {
  const settings = getSettings();
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) return;

  const today = new Date().toISOString().split('T')[0];
  const dayName = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

  // Get all non-admin employees filtered by group
  const allEmps = all('SELECT * FROM users WHERE is_admin=0 ORDER BY first_name');
  const isOffice = u => OFFICE_DEPARTMENTS.map(d=>d.toLowerCase()).includes((u.department||'').toLowerCase().trim());
  const employees = group === 'office'
    ? allEmps.filter(u => isOffice(u))
    : allEmps.filter(u => !isOffice(u));

  if (!employees.length) return;

  // Get who is clocked in today
  const clockedInToday = all("SELECT DISTINCT user_id, user_name, clock_in, clock_type, job_name FROM timeclock WHERE clock_in LIKE ? ORDER BY clock_in", [today + '%']);
  const clockedInIds = new Set(clockedInToday.map(e => e.user_id));

  // Get call-ins for today
  const callInsToday = all("SELECT * FROM callins WHERE call_in_date=?", [today]);
  const callinIds = new Set(callInsToday.map(c => c.user_id));

  // Build roster
  const clocked  = employees.filter(u => clockedInIds.has(u.id));
  const calledIn = employees.filter(u => callinIds.has(u.id) && !clockedInIds.has(u.id));
  const notIn    = employees.filter(u => !clockedInIds.has(u.id) && !callinIds.has(u.id));

  const groupLabel = group === 'office' ? 'Office Staff' : 'Field Technicians';
  const expectedTime = group === 'office' ? '9:00 AM' : '6:00 AM';

  const makeRow = (u, status, statusColor, detail='') =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:500">${u.first_name}${u.last_name?' '+u.last_name:''}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#888;font-size:12px">${u.role||u.department||'—'}</td><td style="padding:8px 12px;border-bottom:1px solid #eee"><span style="background:${statusColor}22;color:${statusColor};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold">${status}</span></td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888">${detail}</td></tr>`;

  let rows = '';
  clocked.forEach(u => {
    const entry = clockedInToday.find(e => e.user_id === u.id);
    const timeIn = entry ? new Date(entry.clock_in).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
    const job = entry && entry.job_name ? ` — ${entry.job_name}` : '';
    rows += makeRow(u, '✓ IN', '#27ae60', timeIn + job);
  });
  calledIn.forEach(u => {
    const ci = callInsToday.find(c => c.user_id === u.id);
    rows += makeRow(u, ci ? ci.call_in_type.toUpperCase() : 'CALLED IN', '#e67e22', ci ? ci.notes||'' : '');
  });
  notIn.forEach(u => {
    rows += makeRow(u, '✗ NOT IN', '#c0392b', '');
  });

  const html = `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#0d0d0d;padding:20px 24px;border-bottom:3px solid #F5A623">
      <span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span>
    </div>
    <div style="padding:24px;background:#ffffff">
      <h2 style="color:#F5A623;margin:0 0 4px">Daily Attendance — ${groupLabel}</h2>
      <p style="color:#888;font-size:13px;margin:0 0 20px">${dayName} &nbsp;|&nbsp; Expected by ${expectedTime}</p>
      <div style="display:flex;gap:24px;margin-bottom:20px">
        <div style="text-align:center;padding:12px 20px;background:#f0faf4;border-radius:8px;border-top:3px solid #27ae60">
          <div style="font-size:28px;font-weight:bold;color:#27ae60">${clocked.length}</div>
          <div style="font-size:12px;color:#888">Clocked In</div>
        </div>
        <div style="text-align:center;padding:12px 20px;background:#fff8f0;border-radius:8px;border-top:3px solid #e67e22">
          <div style="font-size:28px;font-weight:bold;color:#e67e22">${calledIn.length}</div>
          <div style="font-size:12px;color:#888">Called In</div>
        </div>
        <div style="text-align:center;padding:12px 20px;background:#fdf0f0;border-radius:8px;border-top:3px solid #c0392b">
          <div style="font-size:28px;font-weight:bold;color:#c0392b">${notIn.length}</div>
          <div style="font-size:12px;color:#888">Not In Yet</div>
        </div>
        <div style="text-align:center;padding:12px 20px;background:#f9f9f9;border-radius:8px;border-top:3px solid #ccc">
          <div style="font-size:28px;font-weight:bold;color:#555">${employees.length}</div>
          <div style="font-size:12px;color:#888">Total Expected</div>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#f5f5f5">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Employee</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Role</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Status</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em">Details</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:11px;color:#bbb;margin:0">KVM Door Systems Employee Portal &mdash; Daily Attendance Report &mdash; ${today}</p>
    </div>
  </div>`;

  // Get recipients: all admins + anyone with manager role/dept
  const recipients = all("SELECT email FROM users WHERE (is_admin=1 OR department LIKE '%Manager%' OR role LIKE '%Manager%' OR department LIKE '%Management%') AND email!=''").map(u => u.email);
  const uniqueRecipients = [...new Set(recipients)];
  if (!uniqueRecipients.length) return;

  const transporter = nodemailer.createTransport({
    host: settings.smtp_host, port: parseInt(settings.smtp_port)||587,
    secure: false, auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    tls: { rejectUnauthorized: false }
  });

  try {
    await transporter.sendMail({
      from: '"KVM Door Systems" <' + settings.smtp_user + '>',
      to: uniqueRecipients.join(','),
      subject: `Daily Attendance — ${groupLabel} — ${today}`,
      html
    });
    console.log('  Daily attendance email sent:', groupLabel, '->', uniqueRecipients.length, 'recipients');
  } catch(e) {
    console.error('  Daily attendance email error:', e.message);
  }
}

// 7:00 AM Monday-Friday — Field Technicians
cron.schedule('0 7 * * 1-5', async () => {
  console.log('  Sending daily attendance email — Technicians...');
  await sendDailyAttendanceEmail('technicians');
}, { timezone: 'America/Detroit' });

// 9:00 AM Monday-Friday — Office Staff
cron.schedule('0 9 * * 1-5', async () => {
  console.log('  Sending daily attendance email — Office...');
  await sendDailyAttendanceEmail('office');
}, { timezone: 'America/Detroit' });

// Manual trigger endpoint
app.post('/api/attendance/daily-email', requireAdmin, async (req, res) => {
  const { group } = req.body;
  await sendDailyAttendanceEmail(group || 'technicians');
  res.json({ ok: true });
});


// Tardiness is checked inside the clock-in route — patch it here


// Manual perfect attendance trigger (admin)
app.post('/api/attendance/perfect-check', requireAdmin, async (req, res) => {
  const now = new Date();
  const qMap = [null,'Q1','Q1','Q1','Q2','Q2','Q2','Q3','Q3','Q3','Q4','Q4','Q4'];
  const q = qMap[now.getMonth()+1];
  const y = now.getFullYear();
  if (q) await checkPerfectAttendance(q, y);
  res.json({ ok: true, quarter: q, year: y });
});


// Employee self-service call-in
app.post('/api/attendance/my-callin', requireAuth, async (req, res) => {
  const { call_in_date, call_in_type, notes } = req.body;
  if (!call_in_date || !call_in_type) return res.status(400).json({ error: 'Missing fields' });

  // Don't allow No Call No Show as self-reported type
  const allowedTypes = ['Sick','Personal','FMLA','Bereavement','Union Leave'];
  if (!allowedTypes.includes(call_in_type)) return res.status(400).json({ error: 'Invalid call-in type' });

  // Check for duplicate
  const existing = get('SELECT id FROM callins WHERE user_id=? AND call_in_date=?', [req.session.userId, call_in_date]);
  if (existing) return res.status(400).json({ error: 'You already have a call-in logged for that date.' });

  const user = get('SELECT first_name, last_name, email FROM users WHERE id=?', [req.session.userId]);
  const user_name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
  const id = runGetId('INSERT INTO callins (user_id,user_name,call_in_date,call_in_type,notes,logged_by) VALUES (?,?,?,?,?,?)',
    [req.session.userId, user_name, call_in_date, call_in_type, notes||'', user_name + ' (self-reported)']);

  // Log in attendance table too
  const quarter = getQuarter(call_in_date);
  const year = parseInt(call_in_date.split('-')[0]);
  runGetId('INSERT INTO attendance (user_id,user_name,event_date,event_type,notes,logged_by,quarter,year) VALUES (?,?,?,?,?,?,?,?)',
    [req.session.userId, user_name, call_in_date, 'callin', call_in_type + (notes ? ' — ' + notes : ''), user_name + ' (self-reported)', quarter, year]);

  // Notify admins by email
  const settings = getSettings();
  if (settings.smtp_host && settings.smtp_user && settings.smtp_pass) {
    try {
      const adminEmails = all("SELECT email FROM users WHERE (is_admin=1 OR role LIKE '%Manager%' OR department LIKE '%Management%') AND email!=''").map(u=>u.email);
      const uniqueEmails = [...new Set(adminEmails)];
      if (uniqueEmails.length) {
        const transporter = nodemailer.createTransport({ host:settings.smtp_host, port:parseInt(settings.smtp_port)||587, secure:false, auth:{user:settings.smtp_user, pass:settings.smtp_pass}, tls:{rejectUnauthorized:false} });
        const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623;margin:0 0 16px">Call-In Notification</h2><table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="background:#f5f5f5"><td style="padding:10px 14px;font-weight:bold">Employee</td><td style="padding:10px 14px">${user_name}</td></tr><tr><td style="padding:10px 14px;font-weight:bold">Date</td><td style="padding:10px 14px">${call_in_date}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px 14px;font-weight:bold">Type</td><td style="padding:10px 14px">${call_in_type}</td></tr>${notes?`<tr><td style="padding:10px 14px;font-weight:bold">Notes</td><td style="padding:10px 14px">${notes}</td></tr>`:''}</table><hr style="border:none;border-top:1px solid #eee;margin:20px 0"/><p style="font-size:12px;color:#999">Submitted by employee via KVM Employee Portal</p></div></div>`;
        await transporter.sendMail({ from:'"KVM Door Systems" <'+settings.smtp_user+'>', to:uniqueEmails.join(','), subject:`Call-In: ${user_name} — ${call_in_type} — ${call_in_date}`, html });
        run('UPDATE callins SET notified=1 WHERE id=?', [id]);
      }
    } catch(e) { console.error('Admin callin notify error:', e.message); }
  }

  res.json({ id, message: 'Call-in submitted. Your manager has been notified.' });
});

// Get my call-ins
app.get('/api/attendance/my-callins', requireAuth, (req, res) => {
  res.json(all('SELECT * FROM callins WHERE user_id=? ORDER BY call_in_date DESC LIMIT 20', [req.session.userId]));
});


// ═══ CUSTOMER DATABASE ROUTES ════════════════════════════════════════════════

// ─── PERMISSION HELPER ────────────────────────────────────────────────────────
function canAccessCustomers(req) {
  const u = get('SELECT role_type, is_admin FROM users WHERE id=?', [req.session.userId]);
  return u && (u.is_admin || ['admin','billing','sales','dispatcher','manager'].includes(u.role_type));
}
function requireCustomerAccess(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!canAccessCustomers(req)) return res.status(403).json({ error: 'Access denied' });
  next();
}

// ─── JOB NUMBER GENERATOR ─────────────────────────────────────────────────────
function generateJobNumber() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const prefix = mm + yy;
  const lastJob = get(
    "SELECT job_number FROM job_numbers WHERE prefix=? ORDER BY sequence DESC LIMIT 1",
    [prefix]
  );
  const seq = lastJob ? (parseInt(lastJob.job_number.split('-')[1]) + 1) : 1;
  const jobNum = prefix + '-' + seq;
  runGetId('INSERT INTO job_numbers (prefix, job_number, sequence) VALUES (?,?,?)', [prefix, jobNum, seq]);
  return jobNum;
}

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────
app.get('/api/customers', requireCustomerAccess, (req, res) => {
  const { search, type, status } = req.query;
  let sql = 'SELECT c.*, u.first_name || " " || u.last_name as salesperson_name FROM customers c LEFT JOIN users u ON c.assigned_salesperson_id=u.id WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND (c.company_name LIKE ? OR c.billing_city LIKE ?)'; params.push('%'+search+'%','%'+search+'%'); }
  if (type) { sql += ' AND c.customer_type=?'; params.push(type); }
  if (status) { sql += ' AND c.status=?'; params.push(status); }
  else { sql += " AND c.status='active'"; }
  sql += ' ORDER BY c.company_name';
  res.json(all(sql, params));
});

app.get('/api/customers/:id', requireCustomerAccess, (req, res) => {
  const c = get('SELECT * FROM customers WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const sites    = all('SELECT * FROM customer_sites WHERE customer_id=? ORDER BY site_name', [req.params.id]);
  const contacts = all('SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC, last_name', [req.params.id]);
  const equipment = all('SELECT * FROM customer_equipment WHERE customer_id=? ORDER BY site_id, equipment_type', [req.params.id]);
  const docs     = all('SELECT id,customer_id,doc_type,doc_name,file_name,file_type,file_size,notes,uploaded_at FROM partner_documents WHERE customer_id=?', [req.params.id]);
  res.json({ ...c, sites, contacts, equipment, docs });
});

app.post('/api/customers', requireCustomerAccess, (req, res) => {
  const {
    company_name, customer_type, is_partner_company, qb_customer_id,
    billing_address, billing_city, billing_state, billing_zip,
    billing_email, billing_phone, billing_fax, credit_terms,
    tax_exempt, tax_exempt_number, union_required, requires_certified_payroll,
    partner_labor_rate_notes, partner_billing_hours, partner_work_order_instructions,
    partner_checkin_instructions, partner_billing_email, partner_billing_notes,
    internal_notes, assigned_salesperson_id
  } = req.body;
  if (!company_name) return res.status(400).json({ error: 'Company name is required' });
  const id = runGetId(`INSERT INTO customers (
    company_name,customer_type,is_partner_company,qb_customer_id,
    billing_address,billing_city,billing_state,billing_zip,
    billing_email,billing_phone,billing_fax,credit_terms,
    tax_exempt,tax_exempt_number,union_required,requires_certified_payroll,
    partner_labor_rate_notes,partner_billing_hours,partner_work_order_instructions,
    partner_checkin_instructions,partner_billing_email,partner_billing_notes,
    internal_notes,assigned_salesperson_id,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
  [company_name,customer_type||'End User',is_partner_company?1:0,qb_customer_id||'',
   billing_address||'',billing_city||'',billing_state||'',billing_zip||'',
   billing_email||'',billing_phone||'',billing_fax||'',credit_terms||'Net 30',
   tax_exempt?1:0,tax_exempt_number||'',union_required?1:0,requires_certified_payroll?1:0,
   partner_labor_rate_notes||'',partner_billing_hours||0,partner_work_order_instructions||'',
   partner_checkin_instructions||'',partner_billing_email||'',partner_billing_notes||'',
   internal_notes||'',assigned_salesperson_id||0]);
  res.json({ id });
});

app.put('/api/customers/:id', requireCustomerAccess, (req, res) => {
  const {
    company_name, customer_type, is_partner_company, qb_customer_id,
    billing_address, billing_city, billing_state, billing_zip,
    billing_email, billing_phone, billing_fax, credit_terms,
    tax_exempt, tax_exempt_number, union_required, requires_certified_payroll,
    partner_labor_rate_notes, partner_billing_hours, partner_work_order_instructions,
    partner_checkin_instructions, partner_billing_email, partner_billing_notes,
    internal_notes, assigned_salesperson_id, status
  } = req.body;
  run(`UPDATE customers SET
    company_name=?,customer_type=?,is_partner_company=?,qb_customer_id=?,
    billing_address=?,billing_city=?,billing_state=?,billing_zip=?,
    billing_email=?,billing_phone=?,billing_fax=?,credit_terms=?,
    tax_exempt=?,tax_exempt_number=?,union_required=?,requires_certified_payroll=?,
    partner_labor_rate_notes=?,partner_billing_hours=?,partner_work_order_instructions=?,
    partner_checkin_instructions=?,partner_billing_email=?,partner_billing_notes=?,
    internal_notes=?,assigned_salesperson_id=?,status=?,updated_at=datetime('now')
    WHERE id=?`,
  [company_name,customer_type,is_partner_company?1:0,qb_customer_id||'',
   billing_address||'',billing_city||'',billing_state||'',billing_zip||'',
   billing_email||'',billing_phone||'',billing_fax||'',credit_terms||'Net 30',
   tax_exempt?1:0,tax_exempt_number||'',union_required?1:0,requires_certified_payroll?1:0,
   partner_labor_rate_notes||'',partner_billing_hours||0,partner_work_order_instructions||'',
   partner_checkin_instructions||'',partner_billing_email||'',partner_billing_notes||'',
   internal_notes||'',assigned_salesperson_id||0,status||'active',req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/customers/:id', requireAdmin, (req, res) => {
  run("UPDATE customers SET status='inactive' WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

// ─── SITES ────────────────────────────────────────────────────────────────────
app.get('/api/customers/:id/sites', requireCustomerAccess, (req, res) => {
  res.json(all('SELECT * FROM customer_sites WHERE customer_id=? AND status=? ORDER BY site_name', [req.params.id,'active']));
});

app.post('/api/customers/:id/sites', requireCustomerAccess, (req, res) => {
  const { site_name, store_number, address, city, state, zip, site_notes, access_instructions } = req.body;
  const id = runGetId('INSERT INTO customer_sites (customer_id,site_name,store_number,address,city,state,zip,site_notes,access_instructions) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.params.id,site_name||'',store_number||'',address||'',city||'',state||'',zip||'',site_notes||'',access_instructions||'']);
  res.json({ id });
});

app.put('/api/customers/:cid/sites/:id', requireCustomerAccess, (req, res) => {
  const { site_name, store_number, address, city, state, zip, site_notes, access_instructions, status } = req.body;
  run('UPDATE customer_sites SET site_name=?,store_number=?,address=?,city=?,state=?,zip=?,site_notes=?,access_instructions=?,status=? WHERE id=? AND customer_id=?',
    [site_name||'',store_number||'',address||'',city||'',state||'',zip||'',site_notes||'',access_instructions||'',status||'active',req.params.id,req.params.cid]);
  res.json({ ok: true });
});

app.delete('/api/customers/:cid/sites/:id', requireAdmin, (req, res) => {
  run("UPDATE customer_sites SET status='inactive' WHERE id=? AND customer_id=?", [req.params.id,req.params.cid]);
  res.json({ ok: true });
});

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
app.post('/api/customers/:id/contacts', requireCustomerAccess, (req, res) => {
  const { first_name, last_name, title, phone, phone2, email, site_id, is_primary, is_billing_contact, notes } = req.body;
  if (!first_name) return res.status(400).json({ error: 'First name required' });
  if (is_primary) run('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?', [req.params.id]);
  const id = runGetId('INSERT INTO customer_contacts (customer_id,site_id,first_name,last_name,title,phone,phone2,email,is_primary,is_billing_contact,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id,site_id||0,first_name,last_name||'',title||'',phone||'',phone2||'',email||'',is_primary?1:0,is_billing_contact?1:0,notes||'']);
  res.json({ id });
});

app.put('/api/customers/:cid/contacts/:id', requireCustomerAccess, (req, res) => {
  const { first_name, last_name, title, phone, phone2, email, site_id, is_primary, is_billing_contact, notes } = req.body;
  if (is_primary) run('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?', [req.params.cid]);
  run('UPDATE customer_contacts SET first_name=?,last_name=?,title=?,phone=?,phone2=?,email=?,site_id=?,is_primary=?,is_billing_contact=?,notes=? WHERE id=? AND customer_id=?',
    [first_name,last_name||'',title||'',phone||'',phone2||'',email||'',site_id||0,is_primary?1:0,is_billing_contact?1:0,notes||'',req.params.id,req.params.cid]);
  res.json({ ok: true });
});

app.delete('/api/customers/:cid/contacts/:id', requireAdmin, (req, res) => {
  run('DELETE FROM customer_contacts WHERE id=? AND customer_id=?', [req.params.id,req.params.cid]);
  res.json({ ok: true });
});

// ─── EQUIPMENT ────────────────────────────────────────────────────────────────
app.post('/api/customers/:id/equipment', requireCustomerAccess, (req, res) => {
  const { site_id, equipment_type, manufacturer, model, serial_number, size, install_date, warranty_expiry, condition, location_in_site, notes } = req.body;
  const id = runGetId('INSERT INTO customer_equipment (customer_id,site_id,equipment_type,manufacturer,model,serial_number,size,install_date,warranty_expiry,condition,location_in_site,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [req.params.id,site_id||0,equipment_type||'',manufacturer||'',model||'',serial_number||'',size||'',install_date||'',warranty_expiry||'',condition||'',location_in_site||'',notes||'']);
  res.json({ id });
});

app.put('/api/customers/:cid/equipment/:id', requireCustomerAccess, (req, res) => {
  const { site_id, equipment_type, manufacturer, model, serial_number, size, install_date, last_service_date, warranty_expiry, condition, location_in_site, notes } = req.body;
  run('UPDATE customer_equipment SET site_id=?,equipment_type=?,manufacturer=?,model=?,serial_number=?,size=?,install_date=?,last_service_date=?,warranty_expiry=?,condition=?,location_in_site=?,notes=? WHERE id=? AND customer_id=?',
    [site_id||0,equipment_type||'',manufacturer||'',model||'',serial_number||'',size||'',install_date||'',last_service_date||'',warranty_expiry||'',condition||'',location_in_site||'',notes||'',req.params.id,req.params.cid]);
  res.json({ ok: true });
});

app.delete('/api/customers/:cid/equipment/:id', requireAdmin, (req, res) => {
  run('DELETE FROM customer_equipment WHERE id=? AND customer_id=?', [req.params.id,req.params.cid]);
  res.json({ ok: true });
});

// ─── PARTNER DOCUMENTS ────────────────────────────────────────────────────────
app.post('/api/customers/:id/docs', requireCustomerAccess, (req, res) => {
  const { doc_type, doc_name, file_name, file_data, file_type, file_size, notes } = req.body;
  if (!doc_name || !file_data) return res.status(400).json({ error: 'Missing doc name or file' });
  const id = runGetId('INSERT INTO partner_documents (customer_id,doc_type,doc_name,file_name,file_data,file_type,file_size,notes) VALUES (?,?,?,?,?,?,?,?)',
    [req.params.id,doc_type||'',doc_name,file_name||'',file_data,file_type||'',file_size||0,notes||'']);
  res.json({ id });
});

app.get('/api/customers/:id/docs/:docId/download', requireCustomerAccess, (req, res) => {
  const doc = get('SELECT * FROM partner_documents WHERE id=? AND customer_id=?', [req.params.docId,req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const buf = Buffer.from(doc.file_data, 'base64');
  res.setHeader('Content-Type', doc.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + doc.file_name + '"');
  res.send(buf);
});

app.delete('/api/customers/:cid/docs/:id', requireAdmin, (req, res) => {
  run('DELETE FROM partner_documents WHERE id=? AND customer_id=?', [req.params.id,req.params.cid]);
  res.json({ ok: true });
});

// ─── QB DESKTOP IIF EXPORT ────────────────────────────────────────────────────
app.get('/api/customers/export/qb-iif', requireAdmin, (req, res) => {
  const customers = all("SELECT * FROM customers WHERE status='active' ORDER BY company_name");
  let iif = '!CUST	NAME	REFNUM	TIMESTAMP	BSTYPE	ACCNUM	CCARDNUM	ALTDPHONE	EMAIL	CONT1	CONT2	CONT3	ADDR1	ADDR2	ADDR3	ADDR4	ADDR5	CUST	JOBSTATUS	NOTES	TERMS
';
  customers.forEach(c => {
    iif += `CUST	${c.company_name}	${c.qb_customer_id||''}			${c.qb_customer_id||''}		${c.billing_phone||''}	${c.billing_email||''}				${c.billing_address||''}	${c.billing_city||''}${c.billing_city&&c.billing_state?', ':''}	${c.billing_state||''}	${c.billing_zip||''}		TRUE		${c.internal_notes||''}	${c.credit_terms||'Net 30'}
`;
  });
  // Log the sync
  runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',
    ['customer_export', customers.length, 'success', 'Manual IIF export']);
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="KVM_Customers_QB_' + new Date().toISOString().split('T')[0] + '.iif"');
  res.send(iif);
});

// Daily QB sync at 5 PM — generate IIF and email to admins
cron.schedule('0 17 * * 1-5', async () => {
  console.log('  Running daily QB customer sync...');
  const changed = all("SELECT * FROM customers WHERE status='active' AND updated_at > datetime('now','-1 day') ORDER BY company_name");
  if (!changed.length) { console.log('  No customer changes today'); return; }

  const settings = getSettings();
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
    runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',
      ['auto_sync', changed.length, 'skipped', 'Email not configured — download IIF manually from portal']);
    return;
  }

  // Build IIF content for changed customers only
  let iif = '!CUST\tNAME\tREFNUM\tTIMESTAMP\tBSTYPE\tACCNUM\tCCARDNUM\tALTDPHONE\tEMAIL\tCONT1\tCONT2\tCONT3\tADDR1\tADDR2\tADDR3\tADDR4\tADDR5\tCUST\tJOBSTATUS\tNOTES\tTERMS\n';
  changed.forEach(c => {
    iif += 'CUST\t' + [c.company_name, c.qb_customer_id||'', '', '', '', c.qb_customer_id||'', '', c.billing_phone||'', c.billing_email||'', '', '', '',
      c.billing_address||'', (c.billing_city&&c.billing_state)?c.billing_city+', ':c.billing_city||'', c.billing_state||'', c.billing_zip||'', '',
      'TRUE', '', c.internal_notes||'', c.credit_terms||'Net 30'].join('\t') + '\n';
  });

  const adminEmails = all("SELECT email FROM users WHERE (is_admin=1 OR role_type='manager') AND email!=''").map(u=>u.email);
  const uniqueEmails = [...new Set(adminEmails)];
  if (!uniqueEmails.length) return;

  try {
    const transporter = nodemailer.createTransport({ host:settings.smtp_host, port:parseInt(settings.smtp_port)||587, secure:false, auth:{user:settings.smtp_user, pass:settings.smtp_pass}, tls:{rejectUnauthorized:false} });
    const dateStr = new Date().toISOString().split('T')[0];
    await transporter.sendMail({
      from: '"KVM Door Systems" <' + settings.smtp_user + '>',
      to: uniqueEmails.join(','),
      subject: 'Daily QB Customer Sync — ' + changed.length + ' update' + (changed.length!==1?'s':'') + ' — ' + dateStr,
      html: '<div style="font-family:Arial,sans-serif"><div style="background:#0d0d0d;padding:20px;border-bottom:3px solid #F5A623"><span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:3px">KVM DOOR SYSTEMS</span></div><div style="padding:24px"><h2 style="color:#F5A623">QuickBooks Daily Sync</h2><p>' + changed.length + ' customer record' + (changed.length!==1?'s were':'was') + ' updated today. The IIF file is attached.</p><p><strong>To import:</strong> Open QuickBooks Desktop → File → Utilities → Import → IIF Files → select the attached file.</p><hr/><ul>' + changed.map(c => '<li>' + c.company_name + (c.qb_customer_id?' (QB: '+c.qb_customer_id+')':'') + '</li>').join('') + '</ul></div></div>',
      attachments: [{ filename: 'KVM_QB_Sync_' + dateStr + '.iif', content: iif, contentType: 'text/plain' }]
    });
    runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',
      ['auto_sync', changed.length, 'success', 'IIF emailed to ' + uniqueEmails.length + ' recipient(s)']);
    console.log('  QB sync IIF emailed:', changed.length, 'customers to', uniqueEmails.join(', '));
  } catch(e) {
    runGetId('INSERT INTO qb_sync_log (sync_type,records_synced,status,notes) VALUES (?,?,?,?)',
      ['auto_sync', changed.length, 'error', e.message]);
    console.error('  QB sync email error:', e.message);
  }
}, { timezone: 'America/Detroit' });

// QB sync status
app.get('/api/qb/sync-log', requireAdmin, (req, res) => {
  res.json(all('SELECT * FROM qb_sync_log ORDER BY created_at DESC LIMIT 30'));
});

// Search customers (for job/quote autocomplete)
app.get('/api/customers/search', requireCustomerAccess, (req, res) => {
  const q = req.query.q || '';
  const results = all("SELECT id, company_name, customer_type, billing_city, is_partner_company FROM customers WHERE company_name LIKE ? AND status='active' ORDER BY company_name LIMIT 20", ['%'+q+'%']);
  res.json(results);
});

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
