const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const initSqlJs = require('sql.js');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'kvm.db');

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

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
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, priority TEXT DEFAULT 'normal', author_name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT DEFAULT 'General', author_name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS oncall (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT DEFAULT '', phone TEXT NOT NULL, department TEXT DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pto_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, type TEXT DEFAULT 'Vacation', notes TEXT DEFAULT '', days INTEGER NOT NULL, status TEXT DEFAULT 'pending', submitted_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS blackouts (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS oncall_rotation (id INTEGER PRIMARY KEY AUTOINCREMENT, department TEXT NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL)`);
  saveDb();

  // Migrate: add new columns if upgrading
  ['oncall_dept','oncall_role','paired_with'].forEach(col => {
    try { db.run(`ALTER TABLE users ADD COLUMN ${col} TEXT DEFAULT ''`); saveDb(); } catch(e){}
  });
  try { db.run(`ALTER TABLE oncall ADD COLUMN department TEXT DEFAULT ''`); saveDb(); } catch(e){}

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
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));
app.use(cors({origin:['http://kvmdoor.com','https://kvmdoor.com','http://www.kvmdoor.com','https://www.kvmdoor.com'],credentials:true}));
app.use(session({secret:'kvm-door-v3-2024',resave:false,saveUninitialized:false,cookie:{maxAge:8*60*60*1000}}));

const requireAuth  = (req,res,next) => req.session.userId ? next() : res.status(401).json({error:'Not authenticated'});
const requireAdmin = (req,res,next) => (req.session.userId&&req.session.isAdmin) ? next() : res.status(403).json({error:'Admin only'});

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
  const u=get('SELECT id,username,first_name,last_name,role,department,oncall_dept,oncall_role,phone,email,is_admin,pto_total,pto_left,avatar_color FROM users WHERE id=?',[req.session.userId]);
  if(!u) return res.status(404).json({error:'Not found'});
  res.json({...u,is_admin:!!u.is_admin});
});

// ─── USERS ────────────────────────────────────────────────────────────────────
app.get('/api/users',requireAuth,(req,res)=>{
  res.json(all('SELECT id,username,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,pto_total,pto_left,avatar_color FROM users ORDER BY first_name').map(u=>({...u,is_admin:!!u.is_admin})));
});
app.post('/api/users',requireAdmin,(req,res)=>{
  const {username,password,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,pto_total,pto_left,avatar_color}=req.body;
  if(!username||!password||!first_name) return res.status(400).json({error:'Missing required fields'});
  if(get('SELECT id FROM users WHERE username=?',[username])) return res.status(400).json({error:'Username already exists'});
  const id=runGetId(`INSERT INTO users (username,password,first_name,last_name,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,pto_total,pto_left,avatar_color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username,bcrypt.hashSync(password,10),first_name,last_name||'',role||'',department||'',oncall_dept||'',oncall_role||'',paired_with||0,phone||'',email||'',is_admin?1:0,pto_total||10,pto_left||10,avatar_color||'#7a5010']);
  res.json({id});
});
app.put('/api/users/:id',requireAdmin,(req,res)=>{
  const {first_name,last_name,username,role,department,oncall_dept,oncall_role,paired_with,phone,email,is_admin,pto_total,pto_left}=req.body;
  if(!first_name||!username) return res.status(400).json({error:'First name and username are required'});
  // Check username not taken by another user
  const existing=get('SELECT id FROM users WHERE username=? AND id!=?',[username,req.params.id]);
  if(existing) return res.status(400).json({error:'Username already taken by another employee'});
  run(`UPDATE users SET first_name=?,last_name=?,username=?,role=?,department=?,oncall_dept=?,oncall_role=?,paired_with=?,phone=?,email=?,is_admin=?,pto_total=?,pto_left=? WHERE id=?`,
    [first_name,last_name||'',username,role||'',department||'',oncall_dept||'',oncall_role||'',paired_with||0,phone||'',email||'',is_admin?1:0,pto_total||10,pto_left||10,req.params.id]);
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

// ─── BLACKOUTS ────────────────────────────────────────────────────────────────
app.get('/api/blackouts',requireAuth,(req,res)=>res.json(all('SELECT * FROM blackouts ORDER BY start_date')));
app.post('/api/blackouts',requireAdmin,(req,res)=>{
  const {label,start_date,end_date}=req.body; if(!label||!start_date||!end_date) return res.status(400).json({error:'Missing fields'});
  res.json({id:runGetId('INSERT INTO blackouts (label,start_date,end_date) VALUES (?,?,?)',[label,start_date,end_date])});
});
app.delete('/api/blackouts/:id',requireAdmin,(req,res)=>{run('DELETE FROM blackouts WHERE id=?',[req.params.id]);res.json({ok:true});});

// ─── PTO ─────────────────────────────────────────────────────────────────────
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
app.get('/api/settings',requireAdmin,(req,res)=>{ const s=getSettings(); delete s.smtp_pass; res.json(s); });
app.post('/api/settings',requireAdmin,(req,res)=>{
  ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from_name'].forEach(k=>{
    if(req.body[k]!==undefined){ if(get('SELECT key FROM settings WHERE key=?',[k])) run('UPDATE settings SET value=? WHERE key=?',[req.body[k],k]); else run('INSERT INTO settings (key,value) VALUES (?,?)',[k,req.body[k]]); }
  });
  res.json({ok:true});
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
