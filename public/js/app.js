/* ═══ KVM DOOR SYSTEMS PORTAL v3 ═══ */
let currentUser = null;
let oncallFilter = 'current';
let adminPtoFilter = 'pending';
let allUsers = [], allBlackouts = [], rotationData = null;

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW    = ['Su','Mo','Tu','We','Th','Fr','Sa'];

const $ = id => document.getElementById(id);

async function api(method, url, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtDate(str) {
  if (!str) return '—';
  return new Date(str + (str.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function initials(f, l) { return ((f||'')[0] + (l||'')[0]).toUpperCase(); }
function displayName(u) { return u.first_name + (u.last_name ? ' ' + u.last_name : ''); }
function avatarBg(str) {
  const c=['#7a5010','#2980b9','#5d4e8a','#16a085','#b8860b','#1a6e3a','#7f8c8d','#4a6741'];
  let h=0; for(let ch of (str||'')) h=ch.charCodeAt(0)+((h<<5)-h);
  return c[Math.abs(h)%c.length];
}
function businessDays(start, end) {
  let count=0, cur=new Date(start+'T00:00:00');
  const e=new Date(end+'T00:00:00');
  while(cur<=e){const d=cur.getDay();if(d&&d<6)count++;cur.setDate(cur.getDate()+1);}
  return count;
}
function addDays(dateStr, n) {
  const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0];
}
function showToast(msg, type='') {
  const t=$('toast'); t.textContent=msg; t.className='toast show '+(type||'');
  setTimeout(()=>t.className='toast', 3000);
}
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
function closeOnOverlay(e, id) { if(e.target===$(id)) closeModal(id); }
function toggleSidebar() { $('sidebar').classList.toggle('open'); }

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const username=$('loginUser').value.trim(), password=$('loginPass').value;
  const errEl=$('loginError'); errEl.style.display='none';
  try {
    currentUser=await api('POST','/api/login',{username,password});
    $('loginScreen').style.display='none'; $('mainApp').style.display='block';
    setupUI(); showPage('dashboard',null);
  } catch(e){ errEl.textContent=e.message; errEl.style.display='block'; }
}
async function doLogout() {
  await api('POST','/api/logout');
  currentUser=null; allUsers=[]; allBlackouts=[]; rotationData=null;
  $('mainApp').style.display='none'; $('loginScreen').style.display='flex';
  $('loginUser').value=''; $('loginPass').value=''; $('loginError').style.display='none';
}
document.addEventListener('keydown', e => { if(e.key==='Enter'&&$('loginScreen').style.display!=='none') doLogin(); });

function setupUI() {
  const u=currentUser;
  const av=$('topAvatar');
  av.textContent=initials(u.first_name,u.last_name);
  av.style.background=u.avatar_color||avatarBg(u.first_name+u.last_name);
  $('topName').textContent=u.first_name;
  if(u.is_admin){
    $('adminSection').style.display='block';
    ['btnNewAnn','btnNewNews','btnNewOncall','btnAutoSchedule','btnLoadSchedule','btnUploadPolicy'].forEach(id=>{ const el=$(id); if(el) el.style.display='inline-flex'; });
  // Managers can access Manage Employees (limited) and Attendance
  if (currentUser.role_type === 'manager' || currentUser.is_admin) {
    const adminSection = $('adminSection');
    if (adminSection) adminSection.style.display = 'block';
  }
  // Show customer nav for roles with field access
  const fieldRoles = ['admin','manager','billing','sales','dispatcher'];
  if (currentUser.is_admin || fieldRoles.includes(currentUser.role_type||'')) {
    document.querySelectorAll('.nav-item[data-page="customers"]').forEach(el => el.style.display='flex');
  } else {
    document.querySelectorAll('.nav-item[data-page="customers"]').forEach(el => el.style.display='none');
  }
  const allDocsSection = $('allDocsSection');
  if (allDocsSection) allDocsSection.style.display = 'block';
    updatePtoBadge();
  }
}

async function updatePtoBadge() {
  try {
    const reqs=await api('GET','/api/pto');
    const n=reqs.filter(r=>r.status==='pending').length;
    const b=$('ptoPendingBadge');
    if(b){ b.textContent=n; b.style.display=n>0?'inline-block':'none'; }
  } catch(e){}
}

// ─── PAGE ROUTING ─────────────────────────────────────────────────────────────
function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg=$('page-'+name);
  if(pg) pg.classList.add('active');
  if(el) el.classList.add('active');
  $('sidebar').classList.remove('open');
  const map={dashboard:renderDashboard,customers:loadCustomers,customerDetail:loadCustomerDetail,announcements:renderAnnouncements,news:renderNews,oncall:renderOncall,directory:renderDirectory,pto:renderPto,ptoCalendar:renderPtoCalendar,myDocs:renderMyDocs,policies:renderPolicies,timeclock:initTimeclock,adminTimeclock:loadAdminTimecards,adminAlerts:renderAlerts,adminAttendance:initAdminAttendance,adminUsers:renderAdminUsers,adminPto:renderAdminPto,adminBlackout:renderBlackouts,adminRotation:renderRotation,adminSettings:loadSettings};
  if(map[name]) map[name]();
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
async function renderDashboard() {
  const h=new Date().getHours();
  $('dashGreeting').textContent=`${h<12?'Good morning':h<17?'Good afternoon':'Good evening'}, ${currentUser.first_name}. Welcome to the KVM employee portal.`;
  try {
    const [me,ann,oncall]=await Promise.all([api('GET','/api/me'),api('GET','/api/announcements'),api('GET','/api/oncall')]);
    const today=new Date().toISOString().split('T')[0];
    const cur=oncall.filter(o=>o.start_date<=today&&o.end_date>=today);
    const pct=Math.round(me.pto_left/Math.max(me.pto_total,1)*100);
    // Load attendance for dashboard
let myAttendance = null;
try { myAttendance = await api('GET','/api/attendance/my'); } catch(e){}
const tardiesQ = myAttendance ? myAttendance.thisQEvents.filter(e=>e.event_type==='tardy').length : 0;
const callinsQ = myAttendance ? myAttendance.thisQCallins.length : 0;
const hasPerfect = myAttendance && myAttendance.recognition && myAttendance.recognition.length > 0;
$('dashStats').innerHTML=`
      <div class="stat-card"><div class="stat-label">PTO Remaining</div><div class="stat-value" style="color:${pct<20?'var(--danger)':pct<50?'var(--amber)':'var(--green)'}">${me.pto_left}</div><div class="stat-sub">of ${me.pto_total} days this year</div></div>
      <div class="stat-card"><div class="stat-label">On-Call Now</div><div class="stat-value">${cur.length}</div><div class="stat-sub">active across both divisions</div></div>
      <div class="stat-card"><div class="stat-label">Announcements</div><div class="stat-value">${ann.length}</div><div class="stat-sub">total posts</div></div>`;
    $('dashAnnPreview').innerHTML=ann.slice(0,3).map(a=>annItemHTML(a,false)).join('')||'<div class="empty-state">No announcements.</div>';
    const byDept={};
    cur.forEach(o=>{if(!byDept[o.department])byDept[o.department]=[];byDept[o.department].push(o);});
    let ocHtml='';
    if(!cur.length){ ocHtml='<div class="empty-state"><div class="empty-state-icon">📞</div>No one scheduled on call today.</div>'; }
    else {
      ['Automatic Door Division','Overhead Door Division'].forEach(dept=>{
        const entries=byDept[dept]||[];
        if(!entries.length) return;
        ocHtml+=`<div style="margin-bottom:12px"><div class="dept-sub-label">${dept}</div>`;
        entries.forEach(o=>{
          const ac=avatarBg(o.name);
          const inits=o.name.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
          ocHtml+=`<div class="oncall-card" style="margin-bottom:6px"><div class="oncall-avatar" style="background:${ac}22;color:${ac}">${inits}</div><div class="oncall-info"><div class="oncall-name">${o.name}</div><div class="oncall-role">${o.role}</div></div><div class="oncall-phone">${o.phone}</div></div>`;
        });
        ocHtml+='</div>';
      });
    }
    $('dashOncallPreview').innerHTML=ocHtml;
  } catch(e){ console.error(e); }
}

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
function annItemHTML(a, showDelete) {
  const cls=a.priority==='urgent'?'urgent':a.priority==='info'?'info':'';
  const bc=a.priority==='urgent'?'badge-red':a.priority==='info'?'badge-blue':'badge-gray';
  return `<div class="ann-item ${cls}"><div class="ann-item-head"><span class="ann-title">${a.title}</span><span class="badge ${bc}">${a.priority}</span>${showDelete&&currentUser.is_admin?`<button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="deleteAnnouncement(${a.id})">Delete</button>`:''}</div><div class="ann-body">${a.body}</div><div class="ann-meta">${a.author_name} &middot; ${fmtDate(a.created_at)}</div></div>`;
}
async function renderAnnouncements() {
  try { const d=await api('GET','/api/announcements'); $('annList').innerHTML=d.length?d.map(a=>annItemHTML(a,true)).join(''):'<div class="empty-state"><div class="empty-state-icon">📢</div>No announcements yet.</div>'; } catch(e){}
}
async function saveAnnouncement() {
  const title=$('annTitle').value.trim(),body=$('annBody').value.trim();
  if(!title||!body) return showToast('Fill in all fields.','error');
  try { await api('POST','/api/announcements',{title,body,priority:$('annPriority').value}); closeModal('annModal'); $('annTitle').value=''; $('annBody').value=''; showToast('Announcement posted!','success'); renderAnnouncements(); } catch(e){showToast(e.message,'error');}
}
async function deleteAnnouncement(id) { if(!confirm('Delete?'))return; await api('DELETE','/api/announcements/'+id); renderAnnouncements(); }

// ─── NEWS ─────────────────────────────────────────────────────────────────────
const catIcons={'Project Update':'📋','Safety':'⛑️','HR':'👔','Recognition':'🏆','General':'📰'};
function newsItemHTML(n,showDelete) {
  return `<div class="news-item"><div class="news-icon">${catIcons[n.category]||'📰'}</div><div style="flex:1"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div class="news-title">${n.title}</div>${showDelete&&currentUser.is_admin?`<button class="btn btn-danger btn-sm" onclick="deleteNews(${n.id})">Delete</button>`:''}</div><div class="news-body">${n.body}</div><div class="news-meta"><span class="badge badge-green">${n.category}</span> &middot; ${n.author_name} &middot; ${fmtDate(n.created_at)}</div></div></div>`;
}
async function renderNews() {
  try { const d=await api('GET','/api/news'); $('newsList').innerHTML=d.length?d.map(n=>newsItemHTML(n,true)).join(''):'<div class="empty-state"><div class="empty-state-icon">📰</div>No news yet.</div>'; } catch(e){}
}
async function saveNews() {
  const title=$('newsTitle').value.trim(),body=$('newsBody').value.trim();
  if(!title||!body) return showToast('Fill in all fields.','error');
  try { await api('POST','/api/news',{title,body,category:$('newsCat').value}); closeModal('newsModal'); $('newsTitle').value=''; $('newsBody').value=''; showToast('News published!','success'); renderNews(); } catch(e){showToast(e.message,'error');}
}
async function deleteNews(id) { if(!confirm('Delete?'))return; await api('DELETE','/api/news/'+id); renderNews(); }

// ─── ON-CALL ──────────────────────────────────────────────────────────────────
function setOncallFilter(f,el) {
  oncallFilter=f;
  document.querySelectorAll('#page-oncall .tab').forEach(t=>t.classList.remove('active'));
  if(el) el.classList.add('active');
  renderOncall();
}

async function renderOncall() {
  try {
    const all=await api('GET','/api/oncall');
    const today=new Date().toISOString().split('T')[0];
    let list=[...all];
    if(oncallFilter==='current') list=list.filter(o=>o.start_date<=today&&o.end_date>=today);
    if(oncallFilter==='upcoming') list=list.filter(o=>o.start_date>today);
    list.sort((a,b)=>a.start_date.localeCompare(b.start_date));
    if(!list.length){$('oncallList').innerHTML='<div class="empty-state"><div class="empty-state-icon">📞</div>No entries for this period.</div>';return;}

    // Group by week (start_date+end_date combo)
    const weeks = {};
    list.forEach(o => {
      const key = o.start_date + '_' + o.end_date;
      if (!weeks[key]) weeks[key] = { start: o.start_date, end: o.end_date, entries: [] };
      weeks[key].entries.push(o);
    });

    let html = '';
    Object.values(weeks).sort((a,b)=>a.start.localeCompare(b.start)).forEach(week => {
      const isCurWeek = week.start <= today && week.end >= today;
      html += `<div class="oncall-week ${isCurWeek?'oncall-week-active':''}">
        <div class="oncall-week-header">
          <span class="oncall-week-dates">${fmtDate(week.start)} – ${fmtDate(week.end)}</span>
          ${isCurWeek?'<span class="badge badge-amber">CURRENT WEEK</span>':''}
        </div>
        <div class="oncall-week-body">`;

      // Group by department within week
      const byDept = {};
      week.entries.forEach(o => {
        const d = o.department || 'General';
        if (!byDept[d]) byDept[d] = [];
        byDept[d].push(o);
      });

      ['Overhead Door Division','Automatic Door Division','General'].forEach(dept => {
        const entries = byDept[dept];
        if (!entries || !entries.length) return;
        html += `<div class="oncall-dept-row"><span class="oncall-dept-label">${dept.replace(' Division','')}</span><div class="oncall-people">`;
        entries.forEach(o => {
          const ac = avatarBg(o.name);
          const inits = o.name.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
          html += `<div class="oncall-person-chip">
            <div class="oncall-avatar-sm" style="background:${ac}22;color:${ac}">${inits}</div>
            <div>
              <div class="oncall-chip-name">${o.name}</div>
              <div class="oncall-chip-phone">${o.phone}</div>
            </div>
            ${currentUser.is_admin?`<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:11px" onclick="openSwapOncall(${o.id},'${o.name}','${o.department}')">Swap</button><button class="btn btn-danger btn-sm" style="padding:2px 7px;font-size:11px" onclick="deleteOncall(${o.id})">✕</button>`:''}
          </div>`;
        });
        html += '</div></div>';
      });
      html += '</div></div>';
    });
    $('oncallList').innerHTML = html;
  } catch(e) { console.error(e); }
}

// Open the add oncall modal and populate dropdowns
async function openOncallModal() {
  if (!allUsers.length) allUsers = await api('GET', '/api/users');

  const ohUsers = allUsers.filter(u =>
    u.oncall_dept === 'Overhead Door Division' || u.oncall_dept === 'Both Divisions'
  );
  const adUsers = allUsers.filter(u =>
    u.oncall_dept === 'Automatic Door Division' || u.oncall_dept === 'Both Divisions'
  );
  // Fallback: if no dept assigned, show all non-admin
  const fallback = allUsers.filter(u => !u.is_admin);

  const makeOpts = (list) => (list.length ? list : fallback)
    .map(u => `<option value="${u.id}" data-name="${displayName(u)}" data-role="${u.role}" data-phone="${u.phone||''}">${displayName(u)}${u.oncall_role?' — '+u.oncall_role:''}</option>`)
    .join('');

  $('ocOH1').innerHTML = '<option value="">— Select —</option>' + makeOpts(ohUsers);
  $('ocOH2').innerHTML = '<option value="">— Select —</option>' + makeOpts(ohUsers);
  $('ocAD1').innerHTML = '<option value="">— Select —</option>' + makeOpts(adUsers);

  // Default dates: next Monday to Sunday
  const now = new Date();
  const day = now.getDay();
  const toMon = day === 0 ? 1 : 8 - day;
  const nextMon = new Date(now); nextMon.setDate(now.getDate() + toMon);
  const nextSun = new Date(nextMon); nextSun.setDate(nextMon.getDate() + 6);
  $('ocStart').value = nextMon.toISOString().split('T')[0];
  $('ocEnd').value   = nextSun.toISOString().split('T')[0];

  openModal('oncallModal');
}

async function saveOncall() {
  const start_date = $('ocStart').value;
  const end_date   = $('ocEnd').value;
  if (!start_date || !end_date) return showToast('Select start and end dates.','error');

  const getEmpData = (selId) => {
    const sel = $(selId);
    if (!sel || !sel.value) return null;
    const opt = sel.options[sel.selectedIndex];
    return { name: opt.dataset.name, role: opt.dataset.role, phone: opt.dataset.phone };
  };

  const oh1 = getEmpData('ocOH1');
  const oh2 = getEmpData('ocOH2');
  const ad1 = getEmpData('ocAD1');

  if (!oh1 && !ad1) return showToast('Select at least one employee.','error');

  const entries = [];
  if (oh1) entries.push({ ...oh1, department: 'Overhead Door Division', start_date, end_date });
  if (oh2 && oh2.name !== oh1?.name) entries.push({ ...oh2, department: 'Overhead Door Division', start_date, end_date });
  if (ad1) entries.push({ ...ad1, department: 'Automatic Door Division', start_date, end_date });

  try {
    for (const e of entries) await api('POST', '/api/oncall', e);
    closeModal('oncallModal');
    $('ocStart').value = ''; $('ocEnd').value = '';
    showToast(`${entries.length} on-call entries saved!`, 'success');
    renderOncall();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteOncall(id) { if(!confirm('Remove this entry?'))return; await api('DELETE','/api/oncall/'+id); renderOncall(); }

// SWAP FUNCTIONALITY
async function openSwapOncall(id, currentName, dept) {
  if (!allUsers.length) allUsers = await api('GET', '/api/users');
  $('swapOncallId').value = id;
  $('swapOncallCurrentName').textContent = currentName;

  // Show relevant employees for the department
  const relevant = allUsers.filter(u => {
    if (dept === 'Overhead Door Division') return u.oncall_dept === 'Overhead Door Division' || u.oncall_dept === 'Both Divisions';
    if (dept === 'Automatic Door Division') return u.oncall_dept === 'Automatic Door Division' || u.oncall_dept === 'Both Divisions';
    return !u.is_admin;
  });
  const list = relevant.length ? relevant : allUsers.filter(u => !u.is_admin);
  $('swapOncallNewEmp').innerHTML = list
    .map(u => `<option value="${u.id}">${displayName(u)} — ${u.role||u.department}</option>`)
    .join('');
  openModal('swapOncallModal');
}

async function saveOncallSwap() {
  const id = $('swapOncallId').value;
  const user_id = $('swapOncallNewEmp').value;
  try {
    await api('PUT', '/api/oncall/' + id + '/swap', { user_id });
    closeModal('swapOncallModal');
    showToast('Employee swapped!', 'success');
    renderOncall();
  } catch(e) { showToast(e.message, 'error'); }
}

// Legacy populateOncallEmployees kept for compatibility
async function populateOncallEmployees() { await openOncallModal(); }

async function deleteOncall(id) { if(!confirm('Remove?'))return; await api('DELETE','/api/oncall/'+id); renderOncall(); }

// ─── AUTO-SCHEDULE ────────────────────────────────────────────────────────────
async function openAutoScheduleModal() {
  try {
    rotationData=await api('GET','/api/rotation');
    $('schedStart').value=new Date().toISOString().split('T')[0];
    renderRotationLists();
    previewSchedule();
    openModal('autoScheduleModal');
  } catch(e){ showToast(e.message,'error'); }
}

function renderRotationLists() {
  if(!rotationData) return;
  const renderList=(emps, containerId)=>{
    $(containerId).innerHTML=emps.length ? emps.map((e,i)=>{
      const paired=e.paired_with&&parseInt(e.paired_with)>0;
      const name=e.first_name+(e.last_name?' '+e.last_name:'');
      return `<div class="rotation-row" data-uid="${e.id}" draggable="true" ondragstart="dragStart(event)" ondragover="dragOver(event)" ondrop="dropOn(event,'${containerId}')">
        <span class="rotation-pos">${i+1}</span>
        <span class="rotation-drag">⠿</span>
        <span class="rotation-name">${name}</span>
        <span class="rotation-role">${e.oncall_role||''}</span>
        ${paired?`<span class="badge badge-amber" style="font-size:9px">PAIRED</span>`:''}
      </div>`;
    }).join('') : '<div style="padding:8px;font-size:12px;color:var(--text-muted)">No employees assigned.</div>';
  };
  renderList(rotationData.overhead,'rotListOverhead');
  renderList(rotationData.automatic,'rotListAutomatic');
}

// Drag and drop for rotation reorder
let draggedEl=null;
function dragStart(e) { draggedEl=e.currentTarget; e.dataTransfer.effectAllowed='move'; }
function dragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect='move'; }
function dropOn(e, containerId) {
  e.preventDefault();
  if(!draggedEl||draggedEl===e.currentTarget) return;
  const container=$(containerId);
  const rows=[...container.querySelectorAll('.rotation-row')];
  const targetRow=e.currentTarget.closest('.rotation-row');
  if(targetRow&&container.contains(targetRow)) {
    container.insertBefore(draggedEl,targetRow);
    updateRotationNumbers(containerId);
    previewSchedule();
  }
}
function updateRotationNumbers(containerId) {
  document.querySelectorAll(`#${containerId} .rotation-pos`).forEach((el,i)=>el.textContent=i+1);
}

function getRotationOrder(containerId) {
  return [...document.querySelectorAll(`#${containerId} .rotation-row`)].map(row=>({
    id: row.dataset.uid,
    name: row.querySelector('.rotation-name').textContent,
    role: row.querySelector('.rotation-role').textContent,
  }));
}

function previewSchedule() {
  const start=$('schedStart').value;
  const weeks=parseInt($('schedWeeks').value)||8;
  const freq=parseInt($('schedFreq').value)||1;
  if(!start){$('schedPreview').innerHTML='<div class="empty-state">Select a start date.</div>';return;}

  if(!rotationData){$('schedPreview').innerHTML='<div class="empty-state">Loading rotation data...</div>';return;}
  const ohOrder=getRotationOrder('rotListOverhead');
  const auOrder=getRotationOrder('rotListAutomatic');
  if(!ohOrder.length&&!auOrder.length){$('schedPreview').innerHTML='<div class="empty-state">No employees in rotation.</div>';return;}

  // Figure out continuation index (where does the rotation currently stand)
  const ohStart=parseInt($('ohStartIdx').value)||0;
  const auStart=parseInt($('auStartIdx').value)||0;

  const totalSlots=Math.ceil(weeks/freq);
  let html='';
  for(let i=0;i<totalSlots;i++){
    const slotStart=addDays(start,i*freq*7);
    const slotEnd=addDays(slotStart,freq*7-1);

    // Overhead: find pair — if next person has a pair, include both
    let ohNames=[], ohIdx=(ohStart+i)%Math.max(ohOrder.length,1);
    if(ohOrder.length){
      const p=ohOrder[ohIdx];
      // Check if paired in rotationData
      const fullEmp=rotationData.overhead.find(e=>String(e.id)===String(p.id));
      ohNames=[p.name];
      // Find partner
      if(fullEmp&&fullEmp.paired_with&&parseInt(fullEmp.paired_with)>0){
        const partner=ohOrder.find(e=>String(e.id)===String(fullEmp.paired_with));
        if(partner) ohNames=[p.name, partner.name];
      } else {
        // Add second person (next in rotation)
        const p2=ohOrder[(ohIdx+1)%ohOrder.length];
        if(p2&&p2.id!==p.id) ohNames=[p.name, p2.name];
      }
    }

    let auNames=[];
    if(auOrder.length){
      const auIdx=(auStart+i)%auOrder.length;
      auNames=[auOrder[auIdx].name];
    }

    html+=`<div class="rotate-week">
      <div class="rotate-week-header"><span class="rotate-week-title">Week ${i+1}: ${fmtDate(slotStart)} – ${fmtDate(slotEnd)}</span></div>
      <div class="rotate-week-body">
        ${auNames.length?`<div class="rotate-row"><span class="rotate-dept">Auto Door</span><span class="rotate-names">${auNames.join(', ')}</span></div>`:''}
        ${ohNames.length?`<div class="rotate-row"><span class="rotate-dept">Overhead Door</span><span class="rotate-names">${ohNames.join(', ')}</span></div>`:''}
      </div></div>`;
  }
  $('schedPreview').innerHTML=html;
}

async function saveRotationOrder() {
  const ohOrder=getRotationOrder('rotListOverhead').map(e=>e.id);
  const auOrder=getRotationOrder('rotListAutomatic').map(e=>e.id);
  try {
    if(ohOrder.length) await api('PUT','/api/rotation',{department:'Overhead Door Division',order:ohOrder});
    if(auOrder.length) await api('PUT','/api/rotation',{department:'Automatic Door Division',order:auOrder});
    showToast('Rotation order saved!','success');
  } catch(e){ showToast(e.message,'error'); }
}

async function applyAutoSchedule() {
  const start=$('schedStart').value;
  const weeks=parseInt($('schedWeeks').value)||8;
  const freq=parseInt($('schedFreq').value)||1;
  const ohOrder=getRotationOrder('rotListOverhead');
  const auOrder=getRotationOrder('rotListAutomatic');
  if(!start) return showToast('Select a start date.','error');
  if(!ohOrder.length&&!auOrder.length) return showToast('No employees in rotation.','error');
  const totalSlots=Math.ceil(weeks/freq);
  if(!confirm(`Create ${totalSlots} weeks of on-call entries?`)) return;

  const ohStart=parseInt($('ohStartIdx').value)||0;
  const auStart=parseInt($('auStartIdx').value)||0;
  const entries=[];

  for(let i=0;i<totalSlots;i++){
    const slotStart=addDays(start,i*freq*7);
    const slotEnd=addDays(slotStart,freq*7-1);
    // Overhead
    if(ohOrder.length){
      const ohIdx=(ohStart+i)%ohOrder.length;
      const p=ohOrder[ohIdx];
      const fullEmp=rotationData.overhead.find(e=>String(e.id)===String(p.id));
      const users=allUsers.length?allUsers:await api('GET','/api/users');
      const userFull=users.find(u=>String(u.id)===String(p.id));
      entries.push({name:p.name,role:userFull?userFull.role:'',phone:userFull?userFull.phone:'',department:'Overhead Door Division',start_date:slotStart,end_date:slotEnd});
      // Pair or second
      if(fullEmp&&fullEmp.paired_with&&parseInt(fullEmp.paired_with)>0){
        const partnerFull=users.find(u=>String(u.id)===String(fullEmp.paired_with));
        if(partnerFull) entries.push({name:displayName(partnerFull),role:partnerFull.role,phone:partnerFull.phone,department:'Overhead Door Division',start_date:slotStart,end_date:slotEnd});
      } else {
        const p2=ohOrder[(ohIdx+1)%ohOrder.length];
        if(p2&&p2.id!==p.id){const u2=users.find(u=>String(u.id)===String(p2.id)); if(u2) entries.push({name:displayName(u2),role:u2.role,phone:u2.phone,department:'Overhead Door Division',start_date:slotStart,end_date:slotEnd});}
      }
    }
    // Automatic
    if(auOrder.length){
      const auIdx=(auStart+i)%auOrder.length;
      const p=auOrder[auIdx];
      if(!allUsers.length) allUsers=await api('GET','/api/users');
      const u=allUsers.find(x=>String(x.id)===String(p.id));
      if(u) entries.push({name:displayName(u),role:u.role,phone:u.phone,department:'Automatic Door Division',start_date:slotStart,end_date:slotEnd});
    }
  }

  try {
    await saveRotationOrder();
    for(const e of entries) await api('POST','/api/oncall',e);
    closeModal('autoScheduleModal');
    showToast(`Created ${entries.length} on-call entries!`,'success');
    renderOncall();
  } catch(e){ showToast(e.message,'error'); }
}

// ─── ROTATION MANAGEMENT ──────────────────────────────────────────────────────
async function renderRotation() {
  try {
    rotationData=await api('GET','/api/rotation');
    allUsers=await api('GET','/api/users');
    const renderTable=(emps,dept,containerId)=>{
      $(containerId).innerHTML=emps.length?`<table class="data-table"><thead><tr><th>#</th><th>Name</th><th>Role</th><th>Notes</th><th>Reorder</th></tr></thead><tbody>`+
        emps.map((e,i)=>{
          const name=e.first_name+(e.last_name?' '+e.last_name:'');
          const paired=e.paired_with&&parseInt(e.paired_with)>0;
          const partner=paired?emps.find(x=>String(x.id)===String(e.paired_with)):null;
          return `<tr><td style="font-family:Oswald,sans-serif;font-weight:600;color:var(--danger)">${i+1}</td>
            <td><strong>${name}</strong></td>
            <td><span class="badge ${e.oncall_role==='Leader'?'badge-red':'badge-gray'}">${e.oncall_role||'—'}</span></td>
            <td>${paired?`<span class="badge badge-amber">Paired with ${partner?partner.first_name+(partner.last_name?' '+partner.last_name:''):'partner'}</span>`:''}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="moveRotation('${dept}',${i},-1)">↑</button> <button class="btn btn-ghost btn-sm" onclick="moveRotation('${dept}',${i},1)">↓</button></td>
          </tr>`;
        }).join('')+'</tbody></table>'
      :'<div class="empty-state">No employees in this rotation.</div>';
    };
    renderTable(rotationData.overhead,'Overhead Door Division','rotOhTable');
    renderTable(rotationData.automatic,'Automatic Door Division','rotAuTable');
  } catch(e){ console.error(e); }
}

async function moveRotation(dept, idx, dir) {
  const list=dept==='Overhead Door Division'?[...rotationData.overhead]:[...rotationData.automatic];
  const newIdx=idx+dir;
  if(newIdx<0||newIdx>=list.length) return;
  [list[idx],list[newIdx]]=[list[newIdx],list[idx]];
  if(dept==='Overhead Door Division') rotationData.overhead=list;
  else rotationData.automatic=list;
  const order=list.map(e=>e.id);
  await api('PUT','/api/rotation',{department:dept,order});
  renderRotation();
  showToast('Rotation updated.','success');
}

// ─── DIRECTORY ────────────────────────────────────────────────────────────────
async function renderDirectory() {
  try {
    if(!allUsers.length) allUsers=await api('GET','/api/users');
    const q=($('dirSearch').value||'').toLowerCase();
    const filtered=allUsers.filter(u=>!q||(u.first_name+' '+u.last_name+' '+u.role+' '+u.department).toLowerCase().includes(q));
    const deptColors={'Automatic Door':'badge-blue','Overhead Door':'badge-red','Both Divisions':'badge-purple','Management':'badge-gray'};
    $('dirGrid').innerHTML=filtered.length?filtered.map(u=>{
      const ac=u.avatar_color||avatarBg(u.first_name+u.last_name);
      const name=displayName(u);
      const deptBadge=u.oncall_dept?`<span class="badge ${deptColors[u.oncall_dept]||'badge-amber'}" style="font-size:9px;margin-top:4px">${u.oncall_dept.replace(' Division','')}</span>`:'';
      return `<div class="dir-card">${currentUser.is_admin ? `<div style="display:flex;justify-content:flex-end;margin-bottom:6px;gap:6px"><button class="btn btn-ghost btn-sm" onclick="openEditUser(${u.id})">Edit</button><button class="btn btn-ghost btn-sm" onclick="openResetPw(${u.id},'${(u.first_name+' '+u.last_name).trim()}')">Reset PW</button></div>` : ''}<div class="dir-card-top"><div class="avatar" style="width:44px;height:44px;font-size:15px;background:${ac}">${initials(u.first_name,u.last_name)}</div><div><div style="font-weight:500;font-size:13.5px;font-family:Oswald,sans-serif">${name}</div><div style="font-size:11px;color:var(--text-muted)">${u.role||'—'}</div>${deptBadge}</div></div><div class="dir-info" style="margin-top:8px"><div>📞 ${u.phone||'—'}</div><div>✉ ${u.email||'—'}</div><div>🏢 ${u.department||'—'}</div>${u.hire_date?'<div>📅 Hired: '+fmtDate(u.hire_date)+'</div>':''}</div></div>`;
    }).join(''):'<div class="empty-state" style="grid-column:1/-1">No employees found.</div>';
  } catch(e){ console.error(e); }
}

// ─── BLACKOUTS ────────────────────────────────────────────────────────────────
async function loadBlackouts() { try { allBlackouts=await api('GET','/api/blackouts'); } catch(e){ allBlackouts=[]; } }
async function renderBlackouts() {
  await loadBlackouts();
  const el=$('blackoutList');
  if(!allBlackouts.length){el.innerHTML='<div class="empty-state">No blackout dates configured.</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>Label</th><th>Start</th><th>End</th><th>Actions</th></tr></thead><tbody>`+
    allBlackouts.map(b=>`<tr><td><strong>${b.label}</strong></td><td>${fmtDate(b.start_date)}</td><td>${fmtDate(b.end_date)}</td><td><button class="btn btn-danger btn-sm" onclick="deleteBlackout(${b.id})">Remove</button></td></tr>`).join('')+'</tbody></table>';
}
async function saveBlackout() {
  const label=$('boLabel').value.trim(),start=$('boStart').value,end=$('boEnd').value;
  if(!label||!start||!end) return showToast('Fill in all fields.','error');
  try { await api('POST','/api/blackouts',{label,start_date:start,end_date:end}); closeModal('blackoutModal'); $('boLabel').value=''; $('boStart').value=''; $('boEnd').value=''; showToast('Blackout saved!','success'); renderBlackouts(); } catch(e){showToast(e.message,'error');}
}
async function deleteBlackout(id) { if(!confirm('Remove?'))return; await api('DELETE','/api/blackouts/'+id); renderBlackouts(); }
function checkBlackout(s,e) { return allBlackouts.find(b=>s<=b.end_date&&e>=b.start_date)||null; }

// ─── PTO ─────────────────────────────────────────────────────────────────────
async function openPtoReqModal() { await loadBlackouts(); $('blackoutWarning').style.display='none'; $('ptoSubmitBtn').disabled=false; openModal('ptoReqModal'); }
function calcPtoDays() {
  const s=$('ptoStart').value,e=$('ptoEnd').value;
  const calcEl=$('ptoDaysCalc'),warnEl=$('blackoutWarning'),btn=$('ptoSubmitBtn');
  warnEl.style.display='none'; btn.disabled=false;
  if(s&&e&&s<=e){
    calcEl.style.display='block'; calcEl.textContent=`This covers ${businessDays(s,e)} business day${businessDays(s,e)!==1?'s':''}.`;
    const bo=checkBlackout(s,e);
    if(bo){warnEl.textContent=`⚠ Overlaps blackout: "${bo.label}" (${fmtDate(bo.start_date)} – ${fmtDate(bo.end_date)}). Cannot request PTO during this period.`; warnEl.style.display='block'; btn.disabled=true;}
  } else { calcEl.style.display='none'; }
}
async function renderPto() {
  try {
    const [me,reqs]=await Promise.all([api('GET','/api/me'),api('GET','/api/pto')]);
    const used=me.pto_total-me.pto_left, pct=Math.round(me.pto_left/Math.max(me.pto_total,1)*100);
    const cls=pct<20?'low':pct<50?'warn':'';
    $('ptoBalanceCard').innerHTML=`<div class="card-header" style="margin-bottom:.75rem"><span class="card-title">My PTO Balance — ${new Date().getFullYear()}</span></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1rem">
        <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${me.pto_total}</div><div class="stat-sub">days/year</div></div>
        <div class="stat-card"><div class="stat-label">Used</div><div class="stat-value">${used}</div></div>
        <div class="stat-card"><div class="stat-label">Remaining</div><div class="stat-value" style="color:${cls==='low'?'var(--danger)':cls==='warn'?'var(--amber)':'var(--green)'}">${me.pto_left}</div></div>
      </div>
      <div class="pto-bar-wrap"><div class="pto-bar-label"><span>${pct}% remaining</span><span>${me.pto_left} of ${me.pto_total} days</span></div><div class="pto-bar"><div class="pto-fill ${cls}" style="width:${pct}%"></div></div></div>${me.hire_date ? '<div style="margin-top:10px;font-size:12px;color:var(--text-muted);padding:7px 10px;background:var(--bg-surface);border-radius:var(--radius-sm);border-left:3px solid var(--amber)">&#128257; Your PTO renews annually on your hire date: <strong style="color:var(--amber)">' + fmtDate(me.hire_date) + '</strong></div>' : ''}`;
    $('myPtoList').innerHTML=reqs.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Dates</th><th>Type</th><th>Days</th><th>Status</th><th>Notes</th></tr></thead><tbody>`+
      reqs.map(r=>`<tr><td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td><td>${r.type}</td><td>${r.days}</td><td><span class="badge ${r.status==='approved'?'badge-green':r.status==='denied'?'badge-red':'badge-amber'}">${r.status}</span></td><td style="font-size:12px;color:var(--text-muted)">${r.notes||'—'}</td></tr>`).join('')+'</tbody></table></div>'
      :'<div class="empty-state">No requests yet.</div>';
  } catch(e){ console.error(e); }
}
async function submitPto() {
  const start=$('ptoStart').value,end=$('ptoEnd').value,type=$('ptoType').value,notes=$('ptoNotes').value;
  if(!start||!end||start>end) return showToast('Select valid dates.','error');
  try { await api('POST','/api/pto',{start_date:start,end_date:end,type,notes,days:businessDays(start,end)}); closeModal('ptoReqModal'); ['ptoStart','ptoEnd','ptoNotes'].forEach(id=>$(id).value=''); $('ptoDaysCalc').style.display='none'; showToast('Request submitted!','success'); renderPto(); } catch(e){showToast(e.message,'error');}
}

// ─── ADMIN: USERS ─────────────────────────────────────────────────────────────
async function renderAdminUsers() {
  try {
    allUsers=await api('GET','/api/users');
    $('usersTbody').innerHTML=allUsers.map(u=>{
      const pct=Math.round(u.pto_left/Math.max(u.pto_total,1)*100);
      const cls=pct<20?'low':pct<50?'warn':'';
      const name=displayName(u);
      return `<tr>
        <td><strong style="font-family:Oswald,sans-serif">${name}</strong>${u.is_admin?' <span class="badge badge-red">Admin</span>':''}</td>
        <td style="color:var(--text-muted)">${u.username}</td>
        <td>${u.role||'—'}<br><span style="font-size:11px;color:var(--text-faint)">${u.department||''}</span></td>
        <td>${u.oncall_dept?`<span class="badge badge-amber" style="font-size:9px">${u.oncall_dept.replace(' Division','')}</span>`:'<span style="color:var(--text-faint);font-size:12px">—</span>'}</td>
        <td><div style="display:flex;align-items:center;gap:8px"><span style="font-weight:600;min-width:36px;font-family:Oswald,sans-serif">${u.pto_left}/${u.pto_total}</span><div class="pto-bar" style="width:60px;flex-shrink:0"><div class="pto-fill ${cls}" style="width:${pct}%"></div></div></div><div style="font-size:10px;color:var(--text-faint);margin-top:3px">${u.hire_date?'Hired: '+fmtDate(u.hire_date):''}</div></td>
        <td style="white-space:nowrap">${u.id!==1 ? `<button class="btn btn-ghost btn-sm" onclick="openEditUser(${u.id})">Edit</button> <button class="btn btn-ghost btn-sm" onclick="openResetPw(${u.id},'${(u.first_name+' '+u.last_name).trim()}')">Reset PW</button> <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Remove</button>` : '<span style="font-size:11px;color:var(--text-faint)">Protected</span>'}</td>
      </tr>`;
    }).join('');
  } catch(e){ console.error(e); }
}
async function saveUser() {
  const first_name=$('addFirst').value.trim(),last_name=$('addLast').value.trim();
  const username=$('addUsername').value.trim(),password=$('addPass').value;
  if(!first_name||!username||!password) return showToast('Fill in required fields.','error');
  try {
    await api('POST','/api/users',{username,password,first_name,last_name,role:$('addRole').value,department:$('addDept').value,oncall_dept:$('addOncallDept').value,oncall_role:$('addOncallRole').value,phone:$('addPhone').value,email:$('addEmail').value,is_admin:$('addIsAdmin').value==='true',role_type:$('addRoleType')?$('addRoleType').value:'technician',pto_total:parseInt($('addPtoTotal').value)||10,pto_left:parseInt($('addPtoLeft').value)||10,hire_date:$('addHireDate').value||'',avatar_color:avatarBg(first_name+last_name)});
    closeModal('addUserModal'); ['addFirst','addLast','addUsername','addPass','addRole','addDept','addPhone','addEmail','addHireDate'].forEach(id=>$(id).value='');
    allUsers=[]; showToast('Employee added!','success'); renderAdminUsers();
  } catch(e){ showToast(e.message,'error'); }
}
async function deleteUser(id) { if(!confirm('Remove this employee?'))return; try { await api('DELETE','/api/users/'+id); allUsers=[]; showToast('Removed.'); renderAdminUsers(); } catch(e){showToast(e.message,'error');} }

// ─── ADMIN: PTO APPROVAL ──────────────────────────────────────────────────────
function setAdminPtoFilter(f,el) {
  adminPtoFilter=f;
  document.querySelectorAll('#page-adminPto .tab').forEach(t=>t.classList.remove('active'));
  if(el) el.classList.add('active');
  renderAdminPto();
}
async function renderAdminPto() {
  try {
    let reqs=await api('GET','/api/pto');
    if(adminPtoFilter!=='all') reqs=reqs.filter(r=>r.status===adminPtoFilter);
    reqs.sort((a,b)=>new Date(b.submitted_at)-new Date(a.submitted_at));
    $('adminPtoList').innerHTML=reqs.length?reqs.map(r=>`<div class="card" style="margin-bottom:.75rem"><div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px"><div><div style="font-family:Oswald,sans-serif;font-size:16px;font-weight:600">${r.user_name}</div><div style="font-size:13px;color:var(--text-muted);margin-top:3px">${fmtDate(r.start_date)} – ${fmtDate(r.end_date)} &middot; <strong style="color:var(--text)">${r.days} day${r.days!==1?'s':''}</strong> &middot; ${r.type}</div>${r.notes?`<div style="font-size:12px;color:var(--text-faint);margin-top:3px">${r.notes}</div>`:''}<div style="font-size:11px;color:var(--text-faint);margin-top:4px">Submitted ${fmtDate(r.submitted_at)}</div></div><div style="display:flex;align-items:center;gap:8px"><span class="badge ${r.status==='approved'?'badge-green':r.status==='denied'?'badge-red':'badge-amber'}">${r.status}</span>${r.status==='pending'?`<button class="btn btn-success btn-sm" onclick="reviewPto(${r.id},'approved')">Approve</button><button class="btn btn-danger btn-sm" onclick="reviewPto(${r.id},'denied')">Deny</button>`:''}</div></div></div>`).join('')
      :'<div class="empty-state" style="margin-top:1rem">No requests in this category.</div>';
  } catch(e){ console.error(e); }
}
async function reviewPto(id,status) {
  try { await api('PUT','/api/pto/'+id+'/review',{status}); showToast(status==='approved'?'Approved — PTO balance updated. Employee notified.':'Denied — Employee notified.',status==='approved'?'success':''); updatePtoBadge(); renderAdminPto(); } catch(e){showToast(e.message,'error');}
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s=await api('GET','/api/settings');
    ['smtp_host','smtp_port','smtp_user','smtp_from_name'].forEach(k=>{ if(s[k]&&$(k)) $(k).value=s[k]; });
    if(s.gcal_id&&$('gcalId')) $('gcalId').value=s.gcal_id;
  } catch(e){}
}
async function saveSmtpSettings() {
  try { await api('POST','/api/settings',{smtp_host:$('smtpHost').value,smtp_port:$('smtpPort').value,smtp_user:$('smtpUser').value,smtp_pass:$('smtpPass').value,smtp_from_name:$('smtpFromName').value}); showToast('Email settings saved!','success'); } catch(e){showToast(e.message,'error');}
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    currentUser=await api('GET','/api/me');
    $('loginScreen').style.display='none'; $('mainApp').style.display='block';
    setupUI(); await loadBlackouts(); ptoViewYear=new Date().getFullYear(); ptoViewMonth=new Date().getMonth();
    // Handle PWA shortcuts
    const startPage = window._pwaStartPage;
    const startAction = window._pwaStartAction;
    if (startPage) {
      const navEl = document.querySelector('.nav-item[data-page="' + startPage + '"]');
      showPage(startPage, navEl);
    } else if (startAction === 'callin') {
      showPage('dashboard', document.querySelector('.nav-item[data-page="dashboard"]'));
      setTimeout(() => openSelfCallin(), 500);
    } else {
      showPage('dashboard', document.querySelector('.nav-item[data-page="dashboard"]'));
    }
    // Request notification permission after login (politely)
    setTimeout(async () => {
      if (typeof requestNotificationPermission === 'function') {
        await requestNotificationPermission();
      }
    }, 3000);
  } catch(e){ $('loginScreen').style.display='flex'; }
})();

// ─── CHANGE OWN PASSWORD ──────────────────────────────────────────────────────
async function changeMyPassword() {
  const current = $('cpCurrent').value;
  const newPw   = $('cpNew').value;
  const confirm = $('cpConfirm').value;
  const errEl   = $('changePwError');
  errEl.style.display = 'none';

  if (!current || !newPw || !confirm) { errEl.textContent = 'Please fill in all fields.'; errEl.style.display = 'block'; return; }
  if (newPw.length < 6) { errEl.textContent = 'New password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
  if (newPw !== confirm) { errEl.textContent = 'New passwords do not match.'; errEl.style.display = 'block'; return; }

  try {
    await api('PUT', '/api/users/me/password', { current_password: current, new_password: newPw });
    closeModal('changePwModal');
    $('cpCurrent').value = ''; $('cpNew').value = ''; $('cpConfirm').value = '';
    showToast('Password updated successfully!', 'success');
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

// ─── ADMIN: OPEN EDIT EMPLOYEE ────────────────────────────────────────────────
async function openEditUser(id) {
  if (!allUsers.length) allUsers = await api('GET', '/api/users');
  const u = allUsers.find(x => x.id === id || String(x.id) === String(id));
  if (!u) return showToast('Employee not found.', 'error');

  $('editUserId').value    = u.id;
  $('editFirst').value     = u.first_name || '';
  $('editLast').value      = u.last_name  || '';
  $('editUsername').value  = u.username   || '';
  $('editRole').value      = u.role       || '';
  $('editDept').value      = u.department || '';
  $('editPhone').value     = u.phone      || '';
  $('editEmail').value     = u.email      || '';
  $('editPtoTotal').value  = u.pto_total  ?? 10;
  $('editPtoLeft').value   = u.pto_left   ?? 10;
  $('editHireDate').value  = u.hire_date  || '';

  // Set selects
  const oncallDeptEl = $('editOncallDept');
  for (let i = 0; i < oncallDeptEl.options.length; i++) {
    if (oncallDeptEl.options[i].value === (u.oncall_dept || '')) { oncallDeptEl.selectedIndex = i; break; }
  }
  const oncallRoleEl = $('editOncallRole');
  for (let i = 0; i < oncallRoleEl.options.length; i++) {
    if (oncallRoleEl.options[i].value === (u.oncall_role || '')) { oncallRoleEl.selectedIndex = i; break; }
  }
  $('editIsAdmin').value = u.is_admin ? 'true' : 'false';
  if ($('editRoleType')) $('editRoleType').value = u.role_type || 'technician';

  // Lock admin-only fields for managers
  const limitedMode = !currentUser.is_admin && currentUser.role_type === 'manager';
  ['editUsername','editIsAdmin','editPtoTotal','editPtoLeft','editHireDate'].forEach(fid => {
    const el = $(fid);
    if (el) { el.disabled = limitedMode; el.style.opacity = limitedMode ? '0.4' : '1'; el.title = limitedMode ? 'Admin only' : ''; }
  });
  const adminNote = $('editAdminOnlyNote');
  if (adminNote) adminNote.style.display = limitedMode ? 'block' : 'none';

  openModal('editUserModal');
}

async function saveEditUser() {
  const id = $('editUserId').value;
  const isAdmin = currentUser.is_admin;
  const limitedMode = !isAdmin && currentUser.role_type === 'manager';
  const first_name = $('editFirst').value.trim();
  const username   = $('editUsername').value.trim();
  if (!first_name || !username) return showToast('First name and username are required.', 'error');

  try {
    await api('PUT', '/api/users/' + id, {
      first_name,
      last_name:    $('editLast').value.trim(),
      role_type:    $('editRoleType') ? $('editRoleType').value : 'technician',
      username,
      role:         $('editRole').value,
      department:   $('editDept').value,
      oncall_dept:  $('editOncallDept').value,
      oncall_role:  $('editOncallRole').value,
      phone:        $('editPhone').value,
      email:        $('editEmail').value,
      is_admin:     $('editIsAdmin').value === 'true',
      pto_total:    parseInt($('editPtoTotal').value) || 10,
      pto_left:     parseInt($('editPtoLeft').value)  || 10,
      hire_date:    $('editHireDate').value || '',
    });
    closeModal('editUserModal');
    allUsers = []; // clear cache so next load is fresh
    showToast('Employee updated!', 'success');
    // Refresh whichever page is visible
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      const pageId = activePage.id.replace('page-', '');
      if (pageId === 'adminUsers') renderAdminUsers();
      if (pageId === 'directory')  renderDirectory();
    }
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── ADMIN: RESET EMPLOYEE PASSWORD ──────────────────────────────────────────
function openResetPw(id, name) {
  $('resetPwUserId').value  = id;
  $('resetPwName').textContent = name;
  $('resetPwNew').value     = '';
  $('resetPwConfirm').value = '';
  $('resetPwError').style.display = 'none';
  openModal('resetPwModal');
}

async function adminResetPassword() {
  const id      = $('resetPwUserId').value;
  const newPw   = $('resetPwNew').value;
  const confirm = $('resetPwConfirm').value;
  const errEl   = $('resetPwError');
  errEl.style.display = 'none';

  if (!newPw || !confirm) { errEl.textContent = 'Please fill in both fields.'; errEl.style.display = 'block'; return; }
  if (newPw.length < 6)   { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
  if (newPw !== confirm)  { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return; }

  try {
    await api('PUT', '/api/users/' + id + '/password', { new_password: newPw });
    closeModal('resetPwModal');
    showToast('Password reset successfully!', 'success');
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

// ─── PTO CALENDAR PICKER ──────────────────────────────────────────────────────
let calViewYear  = new Date().getFullYear();
let calViewMonth = new Date().getMonth(); // 0-indexed
let calSelectStart = null; // 'YYYY-MM-DD'
let calSelectEnd   = null;
let calClickState  = 0; // 0=picking start, 1=picking end


function ptoCalShift(dir) {
  calViewMonth += dir;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  if (calViewMonth < 0)  { calViewMonth = 11; calViewYear--; }
  syncJumpSelects();
  renderPtoCal();
}

function ptoJump() {
  const m = parseInt($('ptoJumpMonth').value);
  const y = parseInt($('ptoJumpYear').value);
  if (!isNaN(m) && !isNaN(y)) {
    calViewMonth = m;
    calViewYear  = y;
    renderPtoCal();
  }
}

function syncJumpSelects() {
  const mEl = $('ptoJumpMonth');
  const yEl = $('ptoJumpYear');
  if (!mEl || !yEl) return;
  if (!mEl.options.length) {
    MONTHS.forEach((name, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = name;
      mEl.appendChild(o);
    });
    const curY = new Date().getFullYear();
    for (let y = curY - 1; y <= curY + 3; y++) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      yEl.appendChild(o);
    }
  }
  mEl.value = calViewMonth;
  yEl.value = calViewYear;
}

function renderPtoCal() {
  const g1 = $('ptoCalGrid1');
  const g2 = $('ptoCalGrid2');
  const l1 = $('ptoCalLabel1');
  const l2 = $('ptoCalLabel2');
  if (!g1 || !g2) return; // modal not open yet

  const m1 = calViewMonth;
  const y1 = calViewYear;
  let m2 = m1 + 1, y2 = y1;
  if (m2 > 11) { m2 = 0; y2++; }

  if (l1) l1.textContent = MONTHS[m1] + ' ' + y1;
  if (l2) l2.textContent = MONTHS[m2] + ' ' + y2;

  try { g1.innerHTML = buildCalMonth(y1, m1); } catch(e) { g1.innerHTML = '<div style="color:red;font-size:11px">Error: '+e.message+'</div>'; }
  try { g2.innerHTML = buildCalMonth(y2, m2); } catch(e) { g2.innerHTML = ''; }

  // Attach click handlers
  document.querySelectorAll('.pto-cal-day[data-date]').forEach(el => {
    el.addEventListener('click', () => ptoCalDayClick(el.dataset.date));
  });
}

function buildCalMonth(year, month) {
  const today    = new Date().toISOString().split('T')[0];
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Build blackout set
  const blackoutDates = new Set();
  allBlackouts.forEach(b => {
    let cur = new Date(b.start_date + 'T00:00:00');
    const end = new Date(b.end_date + 'T00:00:00');
    while (cur <= end) {
      blackoutDates.add(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
  });

  let html = '<div class="pto-cal-dow">' + DOW.map(d => `<span>${d}</span>`).join('') + '</div>';
  html += '<div class="pto-cal-days">';

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="pto-cal-day pto-day-empty"></div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    const isWeekend   = dow === 0 || dow === 6;
    const isPast      = dateStr < today;
    const isBlackout  = blackoutDates.has(dateStr);
    const isToday     = dateStr === today;
    const isStart     = dateStr === calSelectStart;
    const isEnd       = dateStr === calSelectEnd;
    const inRange     = calSelectStart && calSelectEnd && dateStr > calSelectStart && dateStr < calSelectEnd;

    let cls = 'pto-cal-day';
    if (isBlackout) cls += ' pto-day-blackout';
    else if (isPast) cls += ' pto-day-past';
    else if (isWeekend) cls += ' pto-day-weekend';
    if (isStart) cls += ' pto-day-start';
    if (isEnd)   cls += ' pto-day-end';
    if (inRange) cls += ' pto-day-range';
    if (isToday) cls += ' pto-day-today';

    const clickable = !isPast && !isBlackout ? `data-date="${dateStr}"` : '';
    html += `<div class="${cls}" ${clickable}>${d}</div>`;
  }

  html += '</div>';
  return html;
}

function ptoCalDayClick(dateStr) {
  if (calClickState === 0) {
    // Picking start
    calSelectStart = dateStr;
    calSelectEnd   = null;
    calClickState  = 1;
  } else {
    // Picking end
    if (dateStr < calSelectStart) {
      // Clicked before start — swap
      calSelectEnd   = calSelectStart;
      calSelectStart = dateStr;
    } else {
      calSelectEnd = dateStr;
    }
    calClickState = 0;
  }

  // Sync to text inputs
  $('ptoStart').value = calSelectStart || '';
  $('ptoEnd').value   = calSelectEnd   || '';
  calcPtoDays();
  renderPtoCal();
}

function ptoManualInput() {
  // Sync text inputs back to calendar
  const s = $('ptoStart').value;
  const e = $('ptoEnd').value;
  if (s) {
    calSelectStart = s;
    // Navigate calendar to show start month
    const d = new Date(s + 'T00:00:00');
    calViewYear  = d.getFullYear();
    calViewMonth = d.getMonth();
    syncJumpSelects();
  }
  if (e) calSelectEnd = e;
  calcPtoDays();
  renderPtoCal();
}

// Override openPtoReqModal to init calendar
const _origOpenPtoReqModal = openPtoReqModal;
openPtoReqModal = async function() {
  await loadBlackouts();
  $('blackoutWarning').style.display = 'none';
  $('ptoSubmitBtn').disabled = false;
  // Reset calendar state
  calSelectStart = null;
  calSelectEnd   = null;
  calClickState  = 0;
  $('ptoStart').value = '';
  $('ptoEnd').value   = '';
  $('ptoDaysCalc').style.display = 'none';
  // Set view to current month
  const now = new Date();
  calViewYear  = now.getFullYear();
  calViewMonth = now.getMonth();
  openModal('ptoReqModal');
  // Slight delay to ensure modal is visible before rendering
  setTimeout(() => {
    syncJumpSelects();
    renderPtoCal();
  }, 80);
};

// ─── LOAD KVM PAPER SCHEDULE ──────────────────────────────────────────────────
async function loadKVMSchedule() {
  if (!confirm('This will load your paper on-call schedule (3/21 through 6/19) into the system, replacing any existing future entries. Continue?')) return;
  try {
    const result = await api('POST', '/api/oncall/seed-schedule', {});
    showToast(`Schedule loaded! ${result.created} entries created.`, 'success');
    renderOncall();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

// ─── PTO CALENDAR VIEW ────────────────────────────────────────────────────────
let ptoViewYear  = new Date().getFullYear();
let ptoViewMonth = new Date().getMonth();

function ptoViewShift(dir) {
  const mode = ($('ptoViewMode') && $('ptoViewMode').value) || 'month';
  if (mode === 'week') {
    ptoViewMonth += dir * 0; // shift by week handled differently
    const ref = new Date(ptoViewYear, ptoViewMonth, 1);
    ref.setDate(ref.getDate() + dir * 7);
    ptoViewYear  = ref.getFullYear();
    ptoViewMonth = ref.getMonth();
  } else {
    ptoViewMonth += dir;
    if (ptoViewMonth > 11) { ptoViewMonth = 0; ptoViewYear++; }
    if (ptoViewMonth < 0)  { ptoViewMonth = 11; ptoViewYear--; }
  }
  renderPtoCalendar();
}

async function renderPtoCalendar() {
  const mode = ($('ptoViewMode') && $('ptoViewMode').value) || 'month';
  const labelEl = $('ptoViewLabel');
  const gridEl  = $('ptoCalendarGrid');
  const listEl  = $('ptoCalendarList');
  if (!gridEl) return;

  // Show loading state
  gridEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted);font-size:13px">Loading calendar...</div>';

  // Load ALL approved PTO (admin sees all, employees see their own)
  let allPto = [];
  try { 
    allPto = await api('GET', '/api/pto/all-approved'); 
  } catch(e) {
    try { allPto = await api('GET', '/api/pto'); } catch(e2) {}
  }
  const approved = allPto.filter(r => r.status === 'approved');

  // Load all users for color mapping
  if (!allUsers.length) { try { allUsers = await api('GET', '/api/users'); } catch(e) {} }

  const userColors = {};
  allUsers.forEach(u => { userColors[u.id] = u.avatar_color || avatarBg(u.first_name + (u.last_name||'')); });

  if (mode === 'month') {
    labelEl.textContent = MONTHS[ptoViewMonth] + ' ' + ptoViewYear;
    const firstDay = new Date(ptoViewYear, ptoViewMonth, 1).getDay();
    const daysInMonth = new Date(ptoViewYear, ptoViewMonth + 1, 0).getDate();
    const today = new Date().toISOString().split('T')[0];

    // Build a map of date -> approved requests
    const dayMap = {};
    approved.forEach(r => {
      let cur = new Date(r.start_date + 'T00:00:00');
      const end = new Date(r.end_date + 'T00:00:00');
      while (cur <= end) {
        const ds = cur.toISOString().split('T')[0];
        if (!dayMap[ds]) dayMap[ds] = [];
        dayMap[ds].push(r);
        cur.setDate(cur.getDate() + 1);
      }
    });

    let html = '<div class="ptov-dow-row">' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="ptov-dow">${d}</div>`).join('') + '</div>';
    html += '<div class="ptov-grid">';
    for (let i = 0; i < firstDay; i++) html += '<div class="ptov-cell ptov-empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${ptoViewYear}-${String(ptoViewMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dow = new Date(ds + 'T00:00:00').getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isToday = ds === today;
      const entries = dayMap[ds] || [];
      html += `<div class="ptov-cell ${isWeekend?'ptov-weekend':''} ${isToday?'ptov-today':''}">
        <div class="ptov-day-num ${isToday?'ptov-today-num':''}">${d}</div>
        ${entries.slice(0,3).map(r => {
          const u = allUsers.find(x => x.id == r.user_id);
          const col = u ? (u.avatar_color || avatarBg(u.first_name+(u.last_name||''))) : '#F5A623';
          const name = r.user_name.split(' ')[0];
          return `<div class="ptov-entry" style="background:${col}22;border-left:3px solid ${col};color:${col}">${name}</div>`;
        }).join('')}
        ${entries.length > 3 ? `<div class="ptov-more">+${entries.length-3} more</div>` : ''}
      </div>`;
    }
    html += '</div>';
    gridEl.innerHTML = html;

    // List view below calendar
    const monthStart = `${ptoViewYear}-${String(ptoViewMonth+1).padStart(2,'0')}-01`;
    const monthEnd   = `${ptoViewYear}-${String(ptoViewMonth+1).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;
    const inMonth = approved.filter(r => r.start_date <= monthEnd && r.end_date >= monthStart);
    inMonth.sort((a,b) => a.start_date.localeCompare(b.start_date));
    listEl.innerHTML = inMonth.length
      ? `<table class="data-table"><thead><tr><th>Employee</th><th>Dates</th><th>Days</th><th>Type</th></tr></thead><tbody>`
        + inMonth.map(r => {
          const u = allUsers.find(x => x.id == r.user_id);
          const col = u ? (u.avatar_color || avatarBg(u.first_name+(u.last_name||''))) : '#F5A623';
          return `<tr><td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:${col};display:inline-block"></span>${r.user_name}</span></td><td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td><td>${r.days}</td><td>${r.type}</td></tr>`;
        }).join('') + '</tbody></table>'
      : '<div class="empty-state">No approved time off this month.</div>';

  } else {
    // Week view
    const refDate = new Date(ptoViewYear, ptoViewMonth, 1);
    const dayOfWeek = refDate.getDay();
    const weekStart = new Date(refDate); weekStart.setDate(refDate.getDate() - dayOfWeek);
    const weekEnd   = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    labelEl.textContent = `Week of ${fmtDate(weekStart.toISOString().split('T')[0])}`;

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
      days.push(d.toISOString().split('T')[0]);
    }
    const today = new Date().toISOString().split('T')[0];

    // Build user -> days off map
    const userDays = {};
    approved.forEach(r => {
      days.forEach(ds => {
        if (ds >= r.start_date && ds <= r.end_date) {
          if (!userDays[r.user_id]) userDays[r.user_id] = { name: r.user_name, days: new Set(), type: r.type };
          userDays[r.user_id].days.add(ds);
        }
      });
    });

    let html = `<div class="ptov-week-grid">`;
    html += `<div class="ptov-week-header"><div class="ptov-week-label"></div>` + days.map(ds => {
      const d = new Date(ds+'T00:00:00');
      const isToday = ds === today;
      return `<div class="ptov-week-day ${isToday?'ptov-today':''}">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]}<br><span style="font-size:16px;font-weight:700">${d.getDate()}</span></div>`;
    }).join('') + '</div>';

    Object.entries(userDays).forEach(([uid, data]) => {
      const u = allUsers.find(x => String(x.id) === uid);
      const col = u ? (u.avatar_color || avatarBg(data.name)) : '#F5A623';
      html += `<div class="ptov-week-row">
        <div class="ptov-week-label" style="color:${col}">${data.name.split(' ')[0]}</div>`;
      days.forEach(ds => {
        const off = data.days.has(ds);
        const dow = new Date(ds+'T00:00:00').getDay();
        const isWknd = dow === 0 || dow === 6;
        html += `<div class="ptov-week-cell ${isWknd?'ptov-weekend':''}">${off ? `<div class="ptov-week-off" style="background:${col}33;border:1px solid ${col};color:${col}">Off</div>` : ''}</div>`;
      });
      html += '</div>';
    });

    if (!Object.keys(userDays).length) html += '<div style="grid-column:1/-1;padding:1rem;text-align:center;color:var(--text-faint)">No one off this week.</div>';
    html += '</div>';
    gridEl.innerHTML = html;
    listEl.innerHTML = '';
  }

  // Show Google Calendar link if configured
  try {
    const s = await api('GET', '/api/settings');
    if (s.gcal_id) {
      const link = $('gcalLink');
      if (link) { link.href = `https://calendar.google.com/calendar/r?cid=${s.gcal_id}`; link.style.display = 'inline'; }
    }
  } catch(e) {}
}

// ─── EMAIL TEST ────────────────────────────────────────────────────────────────
async function testEmail() {
  const resultEl = $('emailTestResult');
  resultEl.className = 'alert alert-warning';
  resultEl.textContent = 'Sending test email...';
  resultEl.style.display = 'block';
  try {
    const r = await api('POST', '/api/settings/test-email', {});
    resultEl.className = 'alert alert-success';
    resultEl.textContent = `✓ Test email sent to ${r.sent_to}. Check your inbox!`;
  } catch(e) {
    resultEl.className = 'alert alert-danger';
    resultEl.textContent = `✗ Failed: ${e.message}`;
  }
}

// ─── GOOGLE CALENDAR SETTINGS ─────────────────────────────────────────────────
async function saveGcalSettings() {
  const gcal_id  = $('gcalId') && $('gcalId').value.trim();
  const gcal_key = $('gcalKey') && $('gcalKey').value.trim();
  try {
    await api('POST', '/api/settings', { gcal_id, gcal_key });
    showToast('Google Calendar settings saved!', 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

async function loadGcalSettings() {
  try {
    const s = await api('GET', '/api/settings');
    if (s.gcal_id && $('gcalId')) $('gcalId').value = s.gcal_id;
  } catch(e) {}
}

// ─── DOCUMENTS ────────────────────────────────────────────────────────────────
let docFilter = 'all';
let policyFilter = 'all';

const DOC_TYPE_ICONS = { certification:'🏅', must_card:'🪪', license:'📋', other:'📄' };
const DOC_TYPE_LABELS = { certification:'Certification', must_card:'MUST Card', license:'License', other:'Other' };
const POLICY_CAT_ICONS = { safety:'⛑️', hr:'👔', operations:'🔧', training:'📚', other:'📄' };

function setDocFilter(f, el) {
  docFilter = f;
  document.querySelectorAll('#page-myDocs .doc-type-tabs .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  renderMyDocs();
}

function setPolicyFilter(f, el) {
  policyFilter = f;
  document.querySelectorAll('#page-policies .doc-type-tabs .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  renderPolicies();
}

function fmtFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return Math.round(bytes/1024) + ' KB';
  return (bytes/1024/1024).toFixed(1) + ' MB';
}

function expiryBadge(expiry) {
  if (!expiry) return '';
  const d = new Date(expiry + 'T00:00:00');
  const today = new Date();
  const days = Math.round((d - today) / 86400000);
  if (days < 0) return '<span class="badge badge-red">EXPIRED</span>';
  if (days <= 30) return `<span class="badge badge-amber">EXPIRES SOON</span>`;
  return `<span class="badge badge-green">Valid</span>`;
}

async function renderMyDocs() {
  try {
    const docs = await api('GET', '/api/docs/my');
    const filtered = docFilter === 'all' ? docs : docs.filter(d => d.doc_type === docFilter);

    const el = $('myDocsList');
    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📄</div>No documents uploaded yet. Click "+ Upload Document" to add your certifications and MUST cards.</div>';
    } else {
      el.innerHTML = `<div class="doc-grid">${filtered.map(d => `
        <div class="doc-card">
          <div class="doc-card-icon">${DOC_TYPE_ICONS[d.doc_type]||'📄'}</div>
          <div class="doc-card-info">
            <div class="doc-card-name">${d.doc_name}</div>
            <div class="doc-card-meta">
              <span class="badge badge-amber" style="font-size:9px">${DOC_TYPE_LABELS[d.doc_type]||d.doc_type}</span>
              ${d.expiry_date ? `<span style="font-size:11px;color:var(--text-muted)">Expires: ${fmtDate(d.expiry_date)}</span>` : ''}
              ${expiryBadge(d.expiry_date)}
            </div>
            ${d.notes ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">${d.notes}</div>` : ''}
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px">${d.file_name} &middot; ${fmtFileSize(d.file_size)} &middot; ${fmtDate(d.uploaded_at)}</div>
          </div>
          <div class="doc-card-actions">
            <a href="/api/docs/${d.id}/download" class="btn btn-ghost btn-sm" target="_blank">&#8595; Download</a>
            <button class="btn btn-danger btn-sm" onclick="deleteDoc(${d.id})">Delete</button>
          </div>
        </div>`).join('')}</div>`;
    }

    // Admin: show all employees docs
    if (currentUser.is_admin) renderAllDocs();
  } catch(e) { console.error(e); }
}

async function renderAllDocs() {
  try {
    const docs = await api('GET', '/api/docs/all');
    const q = ($('docEmpSearch') && $('docEmpSearch').value || '').toLowerCase();
    const filtered = q ? docs.filter(d => d.user_name.toLowerCase().includes(q)) : docs;

    // Group by employee
    const byEmp = {};
    filtered.forEach(d => { if (!byEmp[d.user_name]) byEmp[d.user_name] = []; byEmp[d.user_name].push(d); });

    const el = $('allDocsList');
    if (!Object.keys(byEmp).length) { el.innerHTML = '<div class="empty-state">No employee documents found.</div>'; return; }

    el.innerHTML = Object.entries(byEmp).map(([name, empDocs]) => `
      <div style="margin-bottom:1rem">
        <div style="font-family:Oswald,sans-serif;font-size:13px;font-weight:600;color:var(--amber);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">${name}</div>
        <div class="doc-grid">${empDocs.map(d => `
          <div class="doc-card">
            <div class="doc-card-icon">${DOC_TYPE_ICONS[d.doc_type]||'📄'}</div>
            <div class="doc-card-info">
              <div class="doc-card-name">${d.doc_name}</div>
              <div class="doc-card-meta">${expiryBadge(d.expiry_date)}${d.expiry_date?'<span style="font-size:11px;color:var(--text-muted)"> '+fmtDate(d.expiry_date)+'</span>':''}</div>
              <div style="font-size:11px;color:var(--text-faint)">${d.file_name} &middot; ${fmtFileSize(d.file_size)}</div>
            </div>
            <div class="doc-card-actions">
              <a href="/api/docs/${d.id}/download" class="btn btn-ghost btn-sm" target="_blank">&#8595;</a>
              <button class="btn btn-danger btn-sm" onclick="deleteDoc(${d.id})">✕</button>
            </div>
          </div>`).join('')}
        </div>
      </div>`).join('');
  } catch(e) { console.error(e); }
}

async function uploadDocument() {
  const name = $('docName').value.trim();
  const type = $('docType').value;
  const expiry = $('docExpiry').value;
  const notes = $('docNotes').value;
  const file = $('docFile').files[0];

  if (!name) return showToast('Enter a document name.', 'error');
  if (!file) return showToast('Select a file to upload.', 'error');
  if (file.size > 5 * 1024 * 1024) return showToast('File too large. Max 5MB.', 'error');

  const prog = $('docUploadProgress');
  prog.style.display = 'block';
  prog.textContent = 'Reading file...';

  try {
    const base64 = await fileToBase64(file);
    prog.textContent = 'Uploading...';
    await api('POST', '/api/docs', {
      doc_name: name, doc_type: type, expiry_date: expiry, notes,
      file_name: file.name, file_data: base64, file_type: file.type, file_size: file.size
    });
    closeModal('uploadDocModal');
    prog.style.display = 'none';
    ['docName','docExpiry','docNotes'].forEach(id => $(id).value = '');
    $('docFile').value = '';
    showToast('Document uploaded!', 'success');
    renderMyDocs();
  } catch(e) {
    prog.style.display = 'none';
    showToast('Upload failed: ' + e.message, 'error');
  }
}

async function deleteDoc(id) {
  if (!confirm('Delete this document?')) return;
  await api('DELETE', '/api/docs/' + id);
  showToast('Document deleted.');
  renderMyDocs();
}

// ─── POLICIES ─────────────────────────────────────────────────────────────────
async function renderPolicies() {
  try {
    const policies = await api('GET', '/api/policies');
    const filtered = policyFilter === 'all' ? policies : policies.filter(p => p.category === policyFilter);

    const el = $('policiesList');
    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div>' + (currentUser.is_admin ? 'No policy documents yet. Click "+ Add Document" to upload.' : 'No policy documents have been published yet.') + '</div>';
      return;
    }

    // Group by category
    const byCat = {};
    filtered.forEach(p => { if (!byCat[p.category]) byCat[p.category] = []; byCat[p.category].push(p); });

    el.innerHTML = Object.entries(byCat).map(([cat, items]) => `
      <div style="margin-bottom:1.5rem">
        <div class="dept-header" style="margin-top:0;margin-bottom:.75rem">
          <h3>${POLICY_CAT_ICONS[cat]||'📄'} ${cat.charAt(0).toUpperCase()+cat.slice(1)}</h3>
          <span style="font-size:11px;color:var(--text-muted)">${items.length} document${items.length!==1?'s':''}</span>
        </div>
        <div class="doc-grid">${items.map(p => `
          <div class="doc-card">
            <div class="doc-card-icon">${POLICY_CAT_ICONS[p.category]||'📄'}</div>
            <div class="doc-card-info">
              <div class="doc-card-name">${p.title}</div>
              ${p.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${p.description}</div>` : ''}
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">${p.file_name} &middot; ${fmtFileSize(p.file_size)} &middot; Added by ${p.uploaded_by}</div>
            </div>
            <div class="doc-card-actions">
              <a href="/api/policies/${p.id}/download" class="btn btn-ghost btn-sm" target="_blank">&#8595; Download</a>
              ${currentUser.is_admin ? `<button class="btn btn-danger btn-sm" onclick="deletePolicy(${p.id})">Delete</button>` : ''}
            </div>
          </div>`).join('')}
        </div>
      </div>`).join('');
  } catch(e) { console.error(e); }
}

async function uploadPolicy() {
  const title = $('policyName').value.trim();
  const category = $('policyCategory').value;
  const description = $('policyDesc').value;
  const file = $('policyFile').files[0];

  if (!title) return showToast('Enter a document title.', 'error');
  if (!file) return showToast('Select a file to upload.', 'error');
  if (file.size > 10 * 1024 * 1024) return showToast('File too large. Max 10MB.', 'error');

  const prog = $('policyUploadProgress');
  prog.style.display = 'block'; prog.textContent = 'Uploading...';

  try {
    const base64 = await fileToBase64(file);
    await api('POST', '/api/policies', {
      title, category, description,
      file_name: file.name, file_data: base64, file_type: file.type, file_size: file.size
    });
    closeModal('uploadPolicyModal');
    prog.style.display = 'none';
    ['policyName','policyDesc'].forEach(id => $(id).value = '');
    $('policyFile').value = '';
    showToast('Policy document uploaded!', 'success');
    renderPolicies();
  } catch(e) {
    prog.style.display = 'none';
    showToast('Upload failed: ' + e.message, 'error');
  }
}

async function deletePolicy(id) {
  if (!confirm('Delete this policy document?')) return;
  await api('DELETE', '/api/policies/' + id);
  showToast('Document deleted.');
  renderPolicies();
}

// ─── FILE UTILITY ─────────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ─── TIMECLOCK ────────────────────────────────────────────────────────────────
const SHOP_LAT = 42.55514;
const SHOP_LNG = -82.866313;
const GEOFENCE_RADIUS_M = 152.4; // 500 feet in meters
const GEOFENCE_CHECK_INTERVAL = 300000; // 5 minutes
const ALERT_COOLDOWN = 600000; // 10 min between alerts

let clockedInEntry  = null;
let elapsedTimer    = null;
let geofenceWatcher = null;
let lastAlertTime   = {};
let geofenceInterval = null;

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function isAtShop(lat, lng) {
  return haversineDistance(lat, lng, SHOP_LAT, SHOP_LNG) <= GEOFENCE_RADIUS_M;
}

function fmtMinutes(mins) {
  if (!mins) return '0:00';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2,'0')}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function getCurrentWeekValue() {
  const ws = getWeekStart(new Date().toISOString().split('T')[0]);
  const [y, m, d] = ws.split('-');
  // ISO week for input[type=week]
  const jan4 = new Date(parseInt(y), 0, 4);
  const weekNum = Math.ceil(((new Date(ws) - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${y}-W${String(weekNum).padStart(2,'0')}`;
}

async function initTimeclock() {
  // Load current status
  try {
    const s = await api('GET', '/api/timeclock/status');
    clockedInEntry = s.clocked_in ? s.entry : null;
    updateClockUI();
    if (s.clocked_in) startElapsedTimer();
  } catch(e) { console.error(e); }

  // Set default week
  const wkEl = $('myTimecardWeek');
  if (wkEl && !wkEl.value) wkEl.value = getCurrentWeekValue();
  loadMyTimecard();

  // Start geofence monitoring
  startGeofenceMonitor();
}

function updateClockUI() {
  const icon    = $('clockStatusIcon');
  const text    = $('clockStatusText');
  const inTime  = $('clockInTime');
  const inForm  = $('clockInForm');
  const outForm = $('clockOutForm');

  if (clockedInEntry) {
    icon.textContent  = '🟢';
    text.textContent  = 'CLOCKED IN';
    text.style.color  = 'var(--green)';
    inTime.textContent = 'Since: ' + fmtDateTime(clockedInEntry.clock_in) + (clockedInEntry.job_name ? ' — ' + clockedInEntry.job_name : '');
    inForm.style.display  = 'none';
    outForm.style.display = 'block';
  } else {
    icon.textContent  = '⏸️';
    text.textContent  = 'NOT CLOCKED IN';
    text.style.color  = 'var(--text-muted)';
    inTime.textContent = '';
    $('clockElapsed').textContent = '';
    inForm.style.display  = 'block';
    outForm.style.display = 'none';
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }
}

function startElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  const update = () => {
    if (!clockedInEntry) return;
    const mins = Math.floor((Date.now() - new Date(clockedInEntry.clock_in)) / 60000);
    const el = $('clockElapsed');
    if (el) el.textContent = fmtMinutes(mins) + ' elapsed';
  };
  update();
  elapsedTimer = setInterval(update, 30000);
}

function toggleClockType() {
  const type = $('clockTypeSelect').value;
  $('jobFields').style.display    = type === 'field' ? 'block' : 'none';
  $('unionFields').style.display  = type === 'union' ? 'block' : 'none';
}

async function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS not available on this device'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error('Location access denied. Please allow location access in your browser settings.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

async function doClockin() {
  const type = $('clockTypeSelect').value;
  const locEl = $('locationStatus');
  locEl.style.display = 'block';
  locEl.textContent = '📍 Getting your location...';

  try {
    const pos = await getCurrentPosition();
    const atShop = isAtShop(pos.lat, pos.lng);

    // Enforce geofence for shop clock-ins
    if (type === 'shop' && !atShop) {
      locEl.textContent = '⚠️ You must be at the KVM shop to use Shop clock-in. You appear to be ' + Math.round(haversineDistance(pos.lat, pos.lng, SHOP_LAT, SHOP_LNG) * 3.281) + ' feet away. Use Field or Union clock-in instead.';
      return;
    }

    locEl.textContent = '✓ Location confirmed. Clocking in...';

    const payload = {
      latitude: pos.lat, longitude: pos.lng,
      clock_type: type,
      job_name:   type === 'field' ? ($('clockJobName').value || '') : '',
      customer_name: type === 'field' ? ($('clockCustomer').value || '') : '',
      notes:      $('clockNotes').value || '',
      is_union:   type === 'union',
      is_offsite: type !== 'shop'
    };

    const result = await api('POST', '/api/timeclock/in', payload);
    clockedInEntry = { ...payload, id: result.id, clock_in: result.clock_in };
    locEl.style.display = 'none';
    ['clockJobName','clockCustomer','clockNotes'].forEach(id => { const el=$(id); if(el) el.value=''; });
    updateClockUI();
    startElapsedTimer();
    showToast('Clocked in at ' + fmtTime(result.clock_in), 'success');
  } catch(e) {
    locEl.textContent = '❌ ' + e.message;
  }
}

async function doClockout() {
  try {
    let pos = null;
    try { pos = await getCurrentPosition(); } catch(e) {}
    const payload = { notes: $('clockOutNotes').value || '' };
    if (pos) { payload.latitude = pos.lat; payload.longitude = pos.lng; }
    const result = await api('POST', '/api/timeclock/out', payload);
    clockedInEntry = null;
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    $('clockElapsed').textContent = '';
    updateClockUI();
    const hrs = (result.total_minutes / 60).toFixed(2);
    showToast(`Clocked out. Total: ${hrs} hours`, 'success');
    loadMyTimecard();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── GEOFENCE MONITOR ─────────────────────────────────────────────────────────
function startGeofenceMonitor() {
  if (!navigator.geolocation) return;
  let wasAtShop = null;
  let enteredAt = null;

  const check = () => {
    navigator.geolocation.getCurrentPosition(async pos => {
      const atShop = isAtShop(pos.coords.latitude, pos.coords.longitude);
      const geo = $('geofenceCard');
      const geoStatus = $('geofenceStatus');
      if (geo) geo.style.display = 'block';

      const distFt = Math.round(haversineDistance(pos.coords.latitude, pos.coords.longitude, SHOP_LAT, SHOP_LNG) * 3.281);
      if (geoStatus) {
        geoStatus.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:6px 0">
          <span style="font-size:20px">${atShop ? '🟢' : '🔵'}</span>
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--white)">${atShop ? 'You are at the KVM shop' : 'You are away from the shop'}</div>
            <div style="font-size:11px;color:var(--text-muted)">${distFt} feet from shop &middot; GPS accuracy: ±${Math.round(pos.coords.accuracy)} ft</div>
          </div>
        </div>`;
      }

      const now = Date.now();

      if (wasAtShop === false && atShop) {
        // Just arrived at shop
        enteredAt = now;
        wasAtShop = true;
        // After 5 min check if not clocked in
        setTimeout(async () => {
          const s = await api('GET', '/api/timeclock/status').catch(()=>null);
          if (s && !s.clocked_in) {
            const key = 'entered';
            if (!lastAlertTime[key] || now - lastAlertTime[key] > ALERT_COOLDOWN) {
              lastAlertTime[key] = now;
              showGeofenceAlert('entered');
              api('POST', '/api/timeclock/alert', { alert_type: 'entered_without_clockin', latitude: pos.coords.latitude, longitude: pos.coords.longitude }).catch(()=>{});
            }
          }
        }, GEOFENCE_CHECK_INTERVAL);
      }

      if (wasAtShop === true && !atShop) {
        // Just left shop
        wasAtShop = false;
        setTimeout(async () => {
          const s = await api('GET', '/api/timeclock/status').catch(()=>null);
          if (s && s.clocked_in) {
            const key = 'left';
            if (!lastAlertTime[key] || now - lastAlertTime[key] > ALERT_COOLDOWN) {
              lastAlertTime[key] = now;
              showGeofenceAlert('left');
              api('POST', '/api/timeclock/alert', { alert_type: 'left_without_clockout', latitude: pos.coords.latitude, longitude: pos.coords.longitude }).catch(()=>{});
            }
          }
        }, GEOFENCE_CHECK_INTERVAL);
      }

      if (wasAtShop === null) wasAtShop = atShop;
    }, () => {}, { enableHighAccuracy: true, maximumAge: 120000 });
  };

  check();
  geofenceInterval = setInterval(check, 60000); // check every minute
}

function showGeofenceAlert(type) {
  if (type === 'entered') {
    // Try push notification first (works in background on Android)
    if (window.showLocalNotification) {
      window.showLocalNotification(
        '⏱️ KVM — Don\'t forget to clock in!',
        'You have been at the KVM shop. Tap to clock in now.',
        '/?page=timeclock'
      );
    }
    // Also show in-app prompt if app is visible
    if (document.visibilityState === 'visible') {
      if (confirm('⚠️ You have been at the KVM shop for 5 minutes but are not clocked in. Clock in now?')) {
        showPage('timeclock', document.querySelector('.nav-item[data-page="timeclock"]'));
      }
    }
  } else if (type === 'left') {
    if (window.showLocalNotification) {
      window.showLocalNotification(
        '⏱️ KVM — Don\'t forget to clock out!',
        'You have left the KVM shop and are still clocked in. Tap to clock out.',
        '/?page=timeclock'
      );
    }
    if (document.visibilityState === 'visible') {
      if (confirm('⚠️ You have left the KVM shop but are still clocked in. Clock out now?')) {
        doClockout();
      }
    }
  }
}

// Expose geofence check globally so service worker can trigger it
window.runGeofenceCheck = () => {
  navigator.geolocation && navigator.geolocation.getCurrentPosition(async pos => {
    const atShop = isAtShop(pos.coords.latitude, pos.coords.longitude);
    const s = await api('GET', '/api/timeclock/status').catch(()=>null);
    if (!s) return;
    const now = Date.now();
    if (atShop && !s.clocked_in) {
      const key = 'bg-entered';
      if (!lastAlertTime[key] || now - lastAlertTime[key] > ALERT_COOLDOWN) {
        lastAlertTime[key] = now;
        if (window.showLocalNotification) {
          window.showLocalNotification('⏱️ Clock In Reminder', 'You are at KVM. Don\'t forget to clock in!', '/?page=timeclock');
        }
        api('POST', '/api/timeclock/alert', { alert_type: 'entered_without_clockin', latitude: pos.coords.latitude, longitude: pos.coords.longitude }).catch(()=>{});
      }
    }
    if (!atShop && s.clocked_in) {
      const key = 'bg-left';
      if (!lastAlertTime[key] || now - lastAlertTime[key] > ALERT_COOLDOWN) {
        lastAlertTime[key] = now;
        if (window.showLocalNotification) {
          window.showLocalNotification('⏱️ Clock Out Reminder', 'You have left KVM. Don\'t forget to clock out!', '/?page=timeclock');
        }
        api('POST', '/api/timeclock/alert', { alert_type: 'left_without_clockout', latitude: pos.coords.latitude, longitude: pos.coords.longitude }).catch(()=>{});
      }
    }
  }, ()=>{}, { enableHighAccuracy: true, maximumAge: 60000 });
};

// ─── MY TIMECARD ──────────────────────────────────────────────────────────────
async function loadMyTimecard() {
  const wkEl = $('myTimecardWeek');
  if (!wkEl || !wkEl.value) return;
  // Convert week input (2026-W14) to Monday date
  const [yr, wk] = wkEl.value.split('-W');
  const jan4 = new Date(parseInt(yr), 0, 4);
  const weekStart = new Date(jan4.getTime() + (parseInt(wk) - 1) * 7 * 86400000);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const ws = weekStart.toISOString().split('T')[0];

  try {
    const entries = await api('GET', `/api/timeclock/my?week=${ws}`);
    const body = $('myTimecardBody');
    const summary = $('myTimecardSummary');

    if (!entries.length) {
      body.innerHTML = '<div class="empty-state">No time entries for this week.</div>';
      summary.innerHTML = '';
      return;
    }

    let totalMins = 0;
    body.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Type</th><th>In</th><th>Out</th><th>Hours</th><th>Job</th></tr></thead>
      <tbody>${entries.map(e => {
        totalMins += e.total_minutes || 0;
        const typeLabel = e.clock_type === 'shop' ? '🏭 Shop' : e.clock_type === 'union' ? '🤝 Union' : '📍 Field';
        return `<tr>
          <td>${new Date(e.clock_in).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</td>
          <td>${typeLabel}</td>
          <td>${fmtTime(e.clock_in)}</td>
          <td>${e.clock_out ? fmtTime(e.clock_out) : '<span class="badge badge-green">Active</span>'}</td>
          <td><strong>${((e.total_minutes||0)/60).toFixed(2)}</strong></td>
          <td style="font-size:12px;color:var(--text-muted)">${e.job_name||'—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;

    const ot = Math.max(0, totalMins - 2400);
    summary.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem">
      <div class="stat-card"><div class="stat-label">Regular Hours</div><div class="stat-value">${(Math.min(totalMins,2400)/60).toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Overtime</div><div class="stat-value" style="color:${ot>0?'var(--danger)':'var(--green)'}">${(ot/60).toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Hours</div><div class="stat-value" style="color:var(--amber)">${(totalMins/60).toFixed(2)}</div></div>
    </div>`;
  } catch(e) { console.error(e); }
}

// ─── ADMIN TIMECARDS ──────────────────────────────────────────────────────────
async function loadAdminTimecards() {
  const wkEl = $('adminTimecardWeek');
  if (!wkEl) return;
  if (!wkEl.value) wkEl.value = getCurrentWeekValue();

  const [yr, wk] = wkEl.value.split('-W');
  const jan4 = new Date(parseInt(yr), 0, 4);
  const weekStart = new Date(jan4.getTime() + (parseInt(wk)-1) * 7 * 86400000);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const ws = weekStart.toISOString().split('T')[0];

  try {
    const [entries, summary] = await Promise.all([
      api('GET', `/api/timeclock/all?week=${ws}`),
      api('GET', `/api/timeclock/summary?week=${ws}`)
    ]);

    // Summary cards
    const sumEl = $('adminTimecardSummary');
    const totalEmp = summary.summary.length;
    const totalHrs = summary.summary.reduce((a,u) => a + parseFloat(u.total_hours), 0);
    const otCount  = summary.summary.filter(u => parseFloat(u.overtime_hours) > 0).length;
    sumEl.innerHTML = `<div class="card-header" style="margin-bottom:.75rem"><span class="card-title">Week of ${ws}</span></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem">
        <div class="stat-card"><div class="stat-label">Employees</div><div class="stat-value">${totalEmp}</div><div class="stat-sub">with entries</div></div>
        <div class="stat-card"><div class="stat-label">Total Hours</div><div class="stat-value" style="color:var(--amber)">${totalHrs.toFixed(1)}</div></div>
        <div class="stat-card"><div class="stat-label">OT Employees</div><div class="stat-value" style="color:${otCount>0?'var(--danger)':'var(--green)'}">${otCount}</div><div class="stat-sub">over 40 hrs</div></div>
      </div>`;

    // Group entries by user
    const byUser = {};
    entries.forEach(e => {
      if (!byUser[e.user_name]) byUser[e.user_name] = { entries: [], total: 0, uid: e.user_id };
      byUser[e.user_name].entries.push(e);
      byUser[e.user_name].total += e.total_minutes || 0;
    });

    const bodyEl = $('adminTimecardBody');
    bodyEl.innerHTML = Object.entries(byUser).map(([name, data]) => {
      const hrs = (data.total/60).toFixed(2);
      const ot  = Math.max(0, data.total - 2400);
      return `<div class="card" style="margin-bottom:.75rem">
        <div class="card-header">
          <span style="font-family:Oswald,sans-serif;font-size:15px;font-weight:600;color:var(--amber)">${name}</span>
          <div style="display:flex;gap:8px;align-items:center">
            ${ot>0?`<span class="badge badge-red">OT: ${(ot/60).toFixed(2)} hrs</span>`:''}
            <span class="badge badge-amber">${hrs} hrs total</span>
          </div>
        </div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Date</th><th>Type</th><th>In</th><th>Out</th><th>Hours</th><th>Job</th><th>Actions</th></tr></thead>
          <tbody>${data.entries.map(e => `<tr>
            <td>${new Date(e.clock_in).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</td>
            <td>${e.clock_type}${e.is_union?' (Union)':''}</td>
            <td>${fmtTime(e.clock_in)}</td>
            <td>${e.clock_out?fmtTime(e.clock_out):'<span class="badge badge-green">Active</span>'}</td>
            <td><strong>${((e.total_minutes||0)/60).toFixed(2)}</strong></td>
            <td style="font-size:12px;color:var(--text-muted)">${e.job_name||'—'}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="openEditTimeEntry(${e.id},'${e.clock_in}','${e.clock_out||''}','${e.job_name||''}')">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteTimeEntry(${e.id})">✕</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    }).join('') || '<div class="empty-state">No time entries for this week.</div>';
  } catch(e) { console.error(e); }
}

async function sendTimecardEmails() {
  const wkEl = $('adminTimecardWeek');
  const [yr, wk] = (wkEl && wkEl.value ? wkEl.value : getCurrentWeekValue()).split('-W');
  const jan4 = new Date(parseInt(yr), 0, 4);
  const weekStart = new Date(jan4.getTime() + (parseInt(wk)-1) * 7 * 86400000);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const ws = weekStart.toISOString().split('T')[0];
  if (!confirm(`Send timecard emails for week of ${ws} to all employees with time entries?`)) return;
  try {
    const r = await api('POST', '/api/timeclock/send-timecards', { week: ws });
    showToast(`Sent ${r.sent} of ${r.total} timecard emails!`, 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

function openEditTimeEntry(id, clockIn, clockOut, jobName) {
  const newIn  = prompt('Clock In time (YYYY-MM-DDTHH:MM):', clockIn ? clockIn.slice(0,16) : '');
  if (newIn === null) return;
  const newOut = prompt('Clock Out time (YYYY-MM-DDTHH:MM):', clockOut ? clockOut.slice(0,16) : '');
  if (newOut === null) return;
  const newJob = prompt('Job Name:', jobName || '');
  api('PUT', '/api/timeclock/' + id, { clock_in: newIn + ':00', clock_out: newOut ? newOut + ':00' : null, job_name: newJob })
    .then(() => { showToast('Entry updated.', 'success'); loadAdminTimecards(); })
    .catch(e => showToast(e.message, 'error'));
}

async function deleteTimeEntry(id) {
  if (!confirm('Delete this time entry?')) return;
  await api('DELETE', '/api/timeclock/' + id);
  showToast('Entry deleted.');
  loadAdminTimecards();
}

// ─── GEO ALERTS ───────────────────────────────────────────────────────────────
async function renderAlerts() {
  try {
    const alerts = await api('GET', '/api/timeclock/alerts');
    const badge = $('alertsBadge');
    if (badge) { badge.textContent = alerts.length; badge.style.display = alerts.length ? 'inline-block' : 'none'; }
    const el = $('alertsList');
    if (!el) return;
    if (!alerts.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div>No unresolved geofence alerts.</div>'; return; }
    el.innerHTML = alerts.map(a => `
      <div class="card" style="margin-bottom:.75rem;border-left:3px solid ${a.alert_type.includes('without_clockin')?'var(--amber)':'var(--danger)'}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-family:Oswald,sans-serif;font-size:15px;font-weight:600;color:var(--white)">${a.user_name}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
              ${a.alert_type === 'entered_without_clockin' ? '🏭 Arrived at shop without clocking in' : '🚗 Left shop without clocking out'}
            </div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:4px">${fmtDateTime(a.created_at)}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="resolveAlert(${a.id})">Resolve ✓</button>
        </div>
      </div>`).join('');
  } catch(e) { console.error(e); }
}

async function resolveAlert(id) {
  await api('PUT', '/api/timeclock/alerts/' + id + '/resolve', {});
  showToast('Alert resolved.');
  renderAlerts();
}

// ─── ADMIN ATTENDANCE ─────────────────────────────────────────────────────────
let attendanceTab = 'callins';

async function initAdminAttendance() {
  if (!allUsers.length) allUsers = await api('GET', '/api/users');
  // Populate employee selects
  const empOpts = allUsers.filter(u=>!u.is_admin).map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join('');
  ['callinEmpSelect','attEventEmp'].forEach(id=>{ const el=$(id); if(el) el.innerHTML=empOpts; });
  // Default date to today
  ['callinDate','attEventDate'].forEach(id=>{ const el=$(id); if(el && !el.value) el.value=new Date().toISOString().split('T')[0]; });
  // Set quarter/year
  const now = new Date();
  const qMap = {0:'Q1',1:'Q1',2:'Q1',3:'Q2',4:'Q2',5:'Q2',6:'Q3',7:'Q3',8:'Q3',9:'Q4',10:'Q4',11:'Q4'};
  setAttendanceTab(attendanceTab, document.querySelector('#page-adminAttendance .tab'));
}

function setAttendanceTab(tab, el) {
  attendanceTab = tab;
  document.querySelectorAll('#page-adminAttendance .tab-bar .tab').forEach(t=>t.classList.remove('active'));
  if (el) el.classList.add('active');
  loadAttendanceContent();
}

async function loadAttendanceContent() {
  const el = $('attendanceContent');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const { events, callins } = await api('GET', '/api/attendance/all');

    if (attendanceTab === 'callins') {
      if (!callins.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📞</div>No call-ins recorded yet.</div>'; return; }
      el.innerHTML = `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Employee</th><th>Date</th><th>Type</th><th>Notes</th><th>Logged By</th><th>Notified</th><th>Actions</th></tr></thead>
        <tbody>${callins.map(c=>`<tr>
          <td><strong>${c.user_name}</strong></td>
          <td>${fmtDate(c.call_in_date)}</td>
          <td><span class="badge ${c.call_in_type==='No Call No Show'?'badge-red':c.call_in_type==='Sick'?'badge-blue':'badge-amber'}">${c.call_in_type}</span></td>
          <td style="font-size:12px;color:var(--text-muted)">${c.notes||'—'}</td>
          <td style="font-size:12px;color:var(--text-muted)">${c.logged_by}</td>
          <td>${c.notified?'<span class="badge badge-green">Sent</span>':'<span class="badge badge-gray">No</span>'}</td>
          <td><button class="btn btn-danger btn-sm" onclick="deleteCallin(${c.id})">✕</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`;

    } else if (attendanceTab === 'tardies') {
      const tardies = events.filter(e=>e.event_type==='tardy');
      if (!tardies.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏰</div>No tardies recorded yet.</div>'; return; }
      // Group by employee
      const byEmp = {};
      tardies.forEach(t=>{ if(!byEmp[t.user_name]) byEmp[t.user_name]=[]; byEmp[t.user_name].push(t); });
      el.innerHTML = Object.entries(byEmp).sort((a,b)=>b[1].length-a[1].length).map(([name,list])=>`
        <div class="card" style="margin-bottom:.75rem">
          <div class="card-header">
            <span style="font-family:Oswald,sans-serif;font-size:15px;font-weight:600;color:var(--white)">${name}</span>
            <span class="badge ${list.length>=5?'badge-red':list.length>=3?'badge-amber':'badge-gray'}">${list.length} tardy${list.length!==1?'ies':''}</span>
          </div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Date</th><th>Minutes Late</th><th>Notes</th><th>Actions</th></tr></thead>
            <tbody>${list.map(t=>`<tr>
              <td>${fmtDate(t.event_date)}</td>
              <td style="color:var(--amber);font-weight:600">${t.minutes_late} min late</td>
              <td style="font-size:12px;color:var(--text-muted)">${t.notes||'—'}</td>
              <td><button class="btn btn-danger btn-sm" onclick="deleteAttEvent(${t.id})">✕</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>`).join('');

    } else if (attendanceTab === 'report') {
      openQuarterlyReport();
    }
  } catch(e) { el.innerHTML = '<div class="empty-state">Error loading attendance.</div>'; }
}

async function saveCallin() {
  const user_id = $('callinEmpSelect').value;
  const call_in_date = $('callinDate').value;
  const call_in_type = $('callinType').value;
  const notes = $('callinNotes').value;
  if (!user_id || !call_in_date) return showToast('Select employee and date.','error');
  try {
    await api('POST', '/api/attendance/callin', { user_id, call_in_date, call_in_type, notes });
    closeModal('callinModal');
    $('callinNotes').value = '';
    showToast(`Call-in logged for ${call_in_type}. Employee notified.`, 'success');
    loadAttendanceContent();
  } catch(e) { showToast(e.message,'error'); }
}

async function saveAttendanceEvent() {
  const user_id = $('attEventEmp').value;
  const event_date = $('attEventDate').value;
  const event_type = $('attEventType').value;
  const minutes_late = parseInt($('attEventMins').value)||0;
  const notes = $('attEventNotes').value;
  if (!user_id || !event_date) return showToast('Select employee and date.','error');
  try {
    await api('POST', '/api/attendance/event', { user_id, event_date, event_type, minutes_late, notes });
    closeModal('attendanceEventModal');
    showToast('Attendance event logged.', 'success');
    loadAttendanceContent();
  } catch(e) { showToast(e.message,'error'); }
}

async function deleteCallin(id) {
  if (!confirm('Delete this call-in record?')) return;
  await api('DELETE', '/api/attendance/callin/' + id);
  loadAttendanceContent();
}

async function deleteAttEvent(id) {
  if (!confirm('Delete this attendance event?')) return;
  await api('DELETE', '/api/attendance/' + id);
  loadAttendanceContent();
}

function openQuarterlyReport() {
  const now = new Date();
  const qMap = ['Q1','Q1','Q1','Q2','Q2','Q2','Q3','Q3','Q3','Q4','Q4','Q4'];
  const rq = $('reportQuarter');
  const ry = $('reportYear');
  if (rq) rq.value = qMap[now.getMonth()];
  if (ry) ry.value = now.getFullYear();
  openModal('quarterlyReportModal');
}

async function loadQuarterlyReport() {
  const quarter = $('reportQuarter').value;
  const year    = $('reportYear').value;
  const el = $('quarterlyReportContent');
  el.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const data = await api('GET', `/api/attendance/report?quarter=${quarter}&year=${year}`);
    const perfect = data.report.filter(u=>u.is_perfect);
    const withIssues = data.report.filter(u=>!u.is_perfect).sort((a,b)=>(b.tardies+b.callins)-(a.tardies+a.callins));

    let html = '';

    // Perfect attendance section
    if (perfect.length) {
      html += `<div style="background:var(--amber-bg2);border:1px solid var(--amber-dim);border-radius:var(--radius);padding:1rem;margin-bottom:1rem">
        <div style="font-family:Oswald,sans-serif;font-size:14px;font-weight:700;color:var(--amber);margin-bottom:.5rem">&#127942; PERFECT ATTENDANCE — ${quarter} ${year}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${perfect.map(u=>`<span class="badge badge-amber" style="font-size:12px;padding:4px 10px">${u.name}</span>`).join('')}</div>
      </div>`;
    }

    // Summary table
    html += `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Employee</th><th>Role</th><th>Tardies</th><th>Call-Ins</th><th>NCNS</th><th>Absences</th><th>Early Dep.</th><th>Status</th></tr></thead>
      <tbody>${data.report.map(u=>`<tr>
        <td><strong>${u.name}</strong></td>
        <td style="font-size:12px;color:var(--text-muted)">${u.role||'—'}</td>
        <td><span class="${u.tardies>=5?'badge badge-red':u.tardies>=3?'badge badge-amber':'badge badge-gray'}">${u.tardies}</span></td>
        <td><span class="${u.callins>=3?'badge badge-red':u.callins>=1?'badge badge-amber':'badge badge-gray'}">${u.callins}</span></td>
        <td><span class="${u.ncns>0?'badge badge-red':'badge badge-gray'}">${u.ncns}</span></td>
        <td><span class="badge badge-gray">${u.absences}</span></td>
        <td><span class="badge badge-gray">${u.early_departures}</span></td>
        <td>${u.is_perfect?'<span class="badge badge-amber">&#127942; Perfect</span>':u.tardies>=5||u.ncns>0?'<span class="badge badge-red">Needs Review</span>':u.tardies>=3||u.callins>=3?'<span class="badge badge-amber">Monitor</span>':'<span class="badge badge-green">Good</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty-state">Error loading report.</div>'; }
}

async function runPerfectAttendanceCheck() {
  try {
    await api('POST', '/api/attendance/perfect-check', {});
    showToast('Perfect attendance checked. Any new recognitions announced!', 'success');
  } catch(e) { showToast(e.message,'error'); }
}

// ─── EXCEL EXPORT BUTTON ──────────────────────────────────────────────────────
async function exportTimecardExcel() {
  const wkEl = $('adminTimecardWeek');
  const wkVal = wkEl && wkEl.value ? wkEl.value : getCurrentWeekValue();
  const [yr, wk] = wkVal.split('-W');
  const jan4 = new Date(parseInt(yr), 0, 4);
  const weekStart = new Date(jan4.getTime() + (parseInt(wk)-1) * 7 * 86400000);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const ws = weekStart.toISOString().split('T')[0];
  window.open('/api/timeclock/export?week=' + ws, '_blank');
}

// ─── DAILY ATTENDANCE EMAIL TEST ──────────────────────────────────────────────
async function testDailyEmail(group) {
  const resultEl = $('dailyEmailResult');
  resultEl.className = 'alert alert-warning';
  resultEl.textContent = 'Sending ' + (group === 'office' ? 'Office' : 'Technician') + ' attendance email...';
  resultEl.style.display = 'block';
  try {
    await api('POST', '/api/attendance/daily-email', { group });
    resultEl.className = 'alert alert-success';
    resultEl.textContent = '✓ Daily attendance email sent! Check admin inboxes.';
  } catch(e) {
    resultEl.className = 'alert alert-danger';
    resultEl.textContent = '✗ Failed: ' + e.message;
  }
}

// ─── EMPLOYEE SELF CALL-IN ────────────────────────────────────────────────────
function openSelfCallin() {
  // Default to today
  const today = new Date().toISOString().split('T')[0];
  $('selfCallinDate').value = today;
  $('selfCallinNotes').value = '';
  $('selfCallinResult').style.display = 'none';
  openModal('selfCallinModal');
}

async function submitSelfCallin() {
  const call_in_date = $('selfCallinDate').value;
  const call_in_type = $('selfCallinType').value;
  const notes        = $('selfCallinNotes').value.trim();
  const resultEl     = $('selfCallinResult');

  if (!call_in_date) return showToast('Select a date.', 'error');

  // Confirm — this notifies manager
  if (!confirm(`Submit a ${call_in_type} call-in for ${fmtDate(call_in_date)}? Your manager will be notified immediately.`)) return;

  try {
    const r = await api('POST', '/api/attendance/my-callin', { call_in_date, call_in_type, notes });
    resultEl.className = 'alert alert-success';
    resultEl.textContent = '✓ ' + r.message;
    resultEl.style.display = 'block';
    // Auto-close after 2.5 seconds
    setTimeout(() => {
      closeModal('selfCallinModal');
      // Refresh dashboard if visible
      const dash = $('page-dashboard');
      if (dash && dash.classList.contains('active')) renderDashboard();
    }, 2500);
  } catch(e) {
    resultEl.className = 'alert alert-danger';
    resultEl.textContent = '✗ ' + e.message;
    resultEl.style.display = 'block';
  }
}

// ═══ CUSTOMER DATABASE ════════════════════════════════════════════════════════
let currentCustomerId = null;
let currentCustomerData = null;
let custTabActive = 'overview';
let custSitesList = [];

const CUST_TYPES = ['General Contractor','Property Manager','End User / Building Owner','Municipality / Government','Industrial','Retail','Partner Door Company'];
const CUST_TYPE_ICONS = {
  'General Contractor':'🏗️', 'Property Manager':'🏢', 'End User / Building Owner':'🏭',
  'Municipality / Government':'🏛️', 'Industrial':'⚙️', 'Retail':'🛒', 'Partner Door Company':'🤝'
};

// ─── CUSTOMER LIST ────────────────────────────────────────────────────────────
async function loadCustomers() {
  const search  = $('custSearch') ? $('custSearch').value : '';
  const type    = $('custTypeFilter') ? $('custTypeFilter').value : '';
  const partner = $('custPartnerFilter') && $('custPartnerFilter').checked;
  const el = $('customersList');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    let url = '/api/customers?';
    if (search) url += 'search=' + encodeURIComponent(search) + '&';
    if (type) url += 'type=' + encodeURIComponent(type) + '&';
    const customers = await api('GET', url.replace(/[?&]$/, ''));
    const filtered = partner ? customers.filter(c => c.is_partner_company) : customers;

    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏢</div>No customers found. Add your first customer to get started.</div>';
      return;
    }

    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr>
        <th>Company</th><th>Type</th><th>City</th><th>Phone</th>
        <th>Terms</th><th>Salesperson</th><th>Flags</th><th></th>
      </tr></thead>
      <tbody>${filtered.map(c => `<tr style="cursor:pointer" onclick="openCustomerDetail(${c.id})">
        <td>
          <div style="font-weight:600;color:var(--white)">${c.company_name}</div>
          ${c.qb_customer_id ? `<div style="font-size:10px;color:var(--text-faint)">QB: ${c.qb_customer_id}</div>` : ''}
        </td>
        <td><span style="font-size:12px">${CUST_TYPE_ICONS[c.customer_type]||'🏢'} ${c.customer_type}</span></td>
        <td style="font-size:13px;color:var(--text-muted)">${c.billing_city||'—'}, ${c.billing_state||''}</td>
        <td style="font-size:13px">${c.billing_phone||'—'}</td>
        <td><span class="badge badge-gray" style="font-size:10px">${c.credit_terms||'Net 30'}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${c.salesperson_name||'—'}</td>
        <td style="font-size:18px">${c.is_partner_company ? '🤝' : ''}${c.union_required ? '👷' : ''}${c.tax_exempt ? '📋' : ''}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openCustomerDetail(${c.id})">View &#8250;</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div style="font-size:12px;color:var(--text-faint);padding:.5rem 0">${filtered.length} customer${filtered.length!==1?'s':''}</div>`;
  } catch(e) { el.innerHTML = '<div class="empty-state">Error loading customers.</div>'; console.error(e); }
}

// ─── CUSTOMER DETAIL ──────────────────────────────────────────────────────────
async function openCustomerDetail(id) {
  currentCustomerId = id;
  custTabActive = 'overview';
  showPage('customerDetail', null);
}

async function loadCustomerDetail() {
  if (!currentCustomerId) return;
  try {
    currentCustomerData = await api('GET', '/api/customers/' + currentCustomerId);
    const c = currentCustomerData;
    custSitesList = c.sites || [];

    $('custDetailName').textContent = c.company_name;
    $('custDetailType').textContent = (CUST_TYPE_ICONS[c.customer_type]||'') + ' ' + c.customer_type;

    // Partner banner
    const banner = $('partnerBanner');
    if (c.is_partner_company) {
      banner.style.display = 'block';
      banner.className = 'alert alert-warning';
      banner.innerHTML = `<strong>⚠️ Partner Door Company</strong> — Do not discuss pricing with their end customers.
        ${c.partner_billing_hours ? ` Bill within <strong>${c.partner_billing_hours} hours</strong> of job completion.` : ''}
        ${c.partner_billing_email ? ` Submit to: <strong>${c.partner_billing_email}</strong>` : ''}`;
    } else {
      banner.style.display = 'none';
    }

    setCustTab(custTabActive, null);
  } catch(e) { console.error(e); }
}

function setCustTab(tab, el) {
  custTabActive = tab;
  document.querySelectorAll('#page-customerDetail .tab-bar .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  else {
    const tabs = document.querySelectorAll('#page-customerDetail .tab-bar .tab');
    const tabNames = ['overview','sites','contacts','equipment','docs'];
    const idx = tabNames.indexOf(tab);
    if (tabs[idx]) tabs[idx].classList.add('active');
  }
  renderCustTab();
}

function renderCustTab() {
  const c = currentCustomerData;
  if (!c) return;
  const el = $('custDetailContent');

  if (custTabActive === 'overview') {
    el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
      <div class="card">
        <div class="card-header"><span class="card-title">Billing Info</span></div>
        <div class="info-grid">
          <div class="info-row"><span class="info-label">Address</span><span class="info-val">${[c.billing_address,c.billing_city,c.billing_state,c.billing_zip].filter(Boolean).join(', ')||'—'}</span></div>
          <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${c.billing_phone||'—'}</span></div>
          <div class="info-row"><span class="info-label">Fax</span><span class="info-val">${c.billing_fax||'—'}</span></div>
          <div class="info-row"><span class="info-label">Billing Email</span><span class="info-val">${c.billing_email||'—'}</span></div>
          <div class="info-row"><span class="info-label">Terms</span><span class="info-val">${c.credit_terms||'Net 30'}</span></div>
          <div class="info-row"><span class="info-label">QB ID</span><span class="info-val">${c.qb_customer_id||'—'}</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Account Settings</span></div>
        <div class="info-grid">
          <div class="info-row"><span class="info-label">Type</span><span class="info-val">${c.customer_type}</span></div>
          <div class="info-row"><span class="info-label">Tax Exempt</span><span class="info-val">${c.tax_exempt ? '✓ Yes — #'+c.tax_exempt_number : 'No'}</span></div>
          <div class="info-row"><span class="info-label">Union Required</span><span class="info-val">${c.union_required ? '✓ Yes' : 'No'}</span></div>
          <div class="info-row"><span class="info-label">Cert. Payroll</span><span class="info-val">${c.requires_certified_payroll ? '✓ Required' : 'No'}</span></div>
          <div class="info-row"><span class="info-label">Sites</span><span class="info-val">${(c.sites||[]).length} location${(c.sites||[]).length!==1?'s':''}</span></div>
          <div class="info-row"><span class="info-label">Contacts</span><span class="info-val">${(c.contacts||[]).length}</span></div>
        </div>
      </div>
      ${c.is_partner_company ? `<div class="card" style="grid-column:1/-1">
        <div class="card-header"><span class="card-title" style="color:var(--amber)">🤝 Partner Company Requirements</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
          ${c.partner_labor_rate_notes ? `<div><div class="info-label" style="margin-bottom:4px">Labor Rates</div><div style="font-size:13px;white-space:pre-line">${c.partner_labor_rate_notes}</div></div>` : ''}
          ${c.partner_checkin_instructions ? `<div><div class="info-label" style="margin-bottom:4px">Check-In Instructions (shown to tech)</div><div style="font-size:13px;white-space:pre-line;color:var(--amber)">${c.partner_checkin_instructions}</div></div>` : ''}
          ${c.partner_work_order_instructions ? `<div style="grid-column:1/-1"><div class="info-label" style="margin-bottom:4px">Work Order Instructions</div><div style="font-size:13px;white-space:pre-line">${c.partner_work_order_instructions}</div></div>` : ''}
          ${c.partner_billing_notes ? `<div style="grid-column:1/-1"><div class="info-label" style="margin-bottom:4px">Billing Requirements</div><div style="font-size:13px;white-space:pre-line">${c.partner_billing_notes}</div></div>` : ''}
        </div>
      </div>` : ''}
      ${c.internal_notes ? `<div class="card" style="grid-column:1/-1">
        <div class="card-header"><span class="card-title">Internal Notes</span></div>
        <div style="font-size:13px;white-space:pre-line;color:var(--text-muted)">${c.internal_notes}</div>
      </div>` : ''}
    </div>`;

  } else if (custTabActive === 'sites') {
    const sites = c.sites || [];
    el.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
      <button class="btn btn-primary" onclick="openAddSite()">+ Add Site</button>
    </div>
    ${sites.length ? sites.map(s => `<div class="card" style="margin-bottom:.75rem">
      <div class="card-header">
        <div>
          <div style="font-family:Oswald,sans-serif;font-size:15px;font-weight:600;color:var(--white)">${s.site_name||'Unnamed Site'}${s.store_number?' <span style="color:var(--amber);font-size:13px">#'+s.store_number+'</span>':''}</div>
          <div style="font-size:12px;color:var(--text-muted)">${[s.address,s.city,s.state,s.zip].filter(Boolean).join(', ')||'No address'}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="openEditSite(${s.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteSite(${s.id})">✕</button>
        </div>
      </div>
      ${s.site_notes||s.access_instructions ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.5rem">
        ${s.site_notes?`<div><div class="info-label">Notes</div><div style="font-size:12px;color:var(--text-muted)">${s.site_notes}</div></div>`:''}
        ${s.access_instructions?`<div><div class="info-label">Access</div><div style="font-size:12px;color:var(--amber)">${s.access_instructions}</div></div>`:''}
      </div>` : ''}
    </div>`).join('') : '<div class="empty-state">No sites added yet. Click "+ Add Site" to add locations for this customer.</div>'}`;

  } else if (custTabActive === 'contacts') {
    const contacts = c.contacts || [];
    el.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
      <button class="btn btn-primary" onclick="openAddContact()">+ Add Contact</button>
    </div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Name</th><th>Title</th><th>Phone</th><th>Email</th><th>Site</th><th>Role</th><th></th></tr></thead>
      <tbody>${contacts.length ? contacts.map(ct => {
        const site = custSitesList.find(s => s.id === ct.site_id);
        return `<tr>
          <td><strong>${ct.first_name} ${ct.last_name||''}</strong></td>
          <td style="font-size:12px;color:var(--text-muted)">${ct.title||'—'}</td>
          <td>${ct.phone||'—'}</td>
          <td style="font-size:12px">${ct.email||'—'}</td>
          <td style="font-size:12px;color:var(--text-muted)">${site?site.site_name:'All locations'}</td>
          <td>${ct.is_primary?'<span class="badge badge-amber">Primary</span>':''}${ct.is_billing_contact?'<span class="badge badge-blue">Billing</span>':''}</td>
          <td><button class="btn btn-danger btn-sm" onclick="deleteContact(${ct.id})">✕</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--text-faint)">No contacts yet</td></tr>'}</tbody>
    </table></div>`;

  } else if (custTabActive === 'equipment') {
    const equip = c.equipment || [];
    const byType = {};
    equip.forEach(e => { if (!byType[e.equipment_type]) byType[e.equipment_type] = []; byType[e.equipment_type].push(e); });
    el.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
      <button class="btn btn-primary" onclick="openAddEquipment()">+ Add Equipment</button>
    </div>
    ${Object.keys(byType).length ? Object.entries(byType).map(([type,items]) => `
      <div style="margin-bottom:1rem">
        <div class="dept-header" style="margin-bottom:.5rem"><h3>${type}</h3><span style="font-size:11px;color:var(--text-muted)">${items.length} unit${items.length!==1?'s':''}</span></div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Manufacturer</th><th>Model</th><th>Serial #</th><th>Size</th><th>Site</th><th>Condition</th><th>Warranty</th><th></th></tr></thead>
          <tbody>${items.map(e => {
            const site = custSitesList.find(s => s.id === e.site_id);
            const warnExpiry = e.warranty_expiry && new Date(e.warranty_expiry) < new Date();
            return `<tr>
              <td>${e.manufacturer||'—'}</td>
              <td>${e.model||'—'}</td>
              <td style="font-size:12px;font-family:monospace">${e.serial_number||'—'}</td>
              <td>${e.size||'—'}</td>
              <td style="font-size:12px;color:var(--text-muted)">${e.location_in_site||site&&site.site_name||'—'}</td>
              <td><span class="badge ${e.condition==='Good'?'badge-green':e.condition==='Poor'?'badge-red':'badge-amber'}">${e.condition||'Unknown'}</span></td>
              <td>${e.warranty_expiry?`<span style="color:${warnExpiry?'var(--danger)':'var(--text-muted)'};font-size:12px">${fmtDate(e.warranty_expiry)}</span>`:'—'}</td>
              <td><button class="btn btn-danger btn-sm" onclick="deleteEquipment(${e.id})">✕</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`).join('') : '<div class="empty-state">No equipment on file.</div>'}`;

  } else if (custTabActive === 'docs') {
    const docs = c.docs || [];
    const docTypeLabels = { work_order_form:'Work Order Form', pm_checklist:'PM Checklist', billing_instructions:'Billing Instructions', rate_sheet:'Rate Sheet', other:'Other' };
    el.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
      <button class="btn btn-primary" onclick="openModal('partnerDocModal')">+ Upload Document</button>
    </div>
    ${docs.length ? `<div class="doc-grid">${docs.map(d => `
      <div class="doc-card">
        <div class="doc-card-icon">📄</div>
        <div class="doc-card-info">
          <div class="doc-card-name">${d.doc_name}</div>
          <div class="doc-card-meta">
            <span class="badge badge-amber" style="font-size:9px">${docTypeLabels[d.doc_type]||d.doc_type}</span>
            <span style="font-size:11px;color:var(--text-faint)">${d.file_name} &middot; ${fmtFileSize(d.file_size)}</span>
          </div>
          ${d.notes?`<div style="font-size:11px;color:var(--text-muted)">${d.notes}</div>`:''}
        </div>
        <div class="doc-card-actions">
          <a href="/api/customers/${currentCustomerId}/docs/${d.id}/download" class="btn btn-ghost btn-sm" target="_blank">&#8595; Download</a>
          <button class="btn btn-danger btn-sm" onclick="deletePartnerDoc(${d.id})">Delete</button>
        </div>
      </div>`).join('')}</div>` : '<div class="empty-state">No documents uploaded. Upload work order forms, PM checklists, and rate sheets for this partner.</div>'}`;
  }
}

// ─── CUSTOMER CRUD ────────────────────────────────────────────────────────────
async function openAddCustomer() {
  try {
    if (!allUsers.length) allUsers = await api('GET', '/api/users');
  } catch(e) { allUsers = []; }
  
  $('custModalId').value = '';
  $('customerModalTitle').textContent = 'Add Customer';
  ['custName','custQbId','custBillingAddr','custBillingCity','custBillingState','custBillingZip',
   'custBillingPhone','custBillingFax','custBillingEmail','custInternalNotes','custTaxExemptNum',
   'custPartnerLaborNotes','custPartnerCheckin','custPartnerWOInstructions',
   'custPartnerBillingNotes','custPartnerBillingEmail'].forEach(id => { const el=$(id); if(el) el.value=''; });
  ['custTaxExempt','custUnion','custCertPayroll'].forEach(id => { const el=$(id); if(el) el.checked=false; });
  if ($('custType')) $('custType').value = 'General Contractor';
  if ($('custTerms')) $('custTerms').value = 'Net 30';
  
  // Populate salesperson dropdown with all users
  const spEl = $('custSalesperson');
  if (spEl) {
    spEl.innerHTML = '<option value="0">— Unassigned —</option>' + 
      allUsers.map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join('');
  }
  togglePartnerFields();
  openModal('customerModal');
}

function openEditCustomer() {
  const c = currentCustomerData;
  if (!c) return;
  $('custModalId').value = c.id;
  $('customerModalTitle').textContent = 'Edit Customer';
  $('custName').value = c.company_name || '';
  $('custQbId').value = c.qb_customer_id || '';
  $('custType').value = c.customer_type || 'General Contractor';
  $('custTerms').value = c.credit_terms || 'Net 30';
  $('custBillingAddr').value = c.billing_address || '';
  $('custBillingCity').value = c.billing_city || '';
  $('custBillingState').value = c.billing_state || '';
  $('custBillingZip').value = c.billing_zip || '';
  $('custBillingPhone').value = c.billing_phone || '';
  $('custBillingFax').value = c.billing_fax || '';
  $('custBillingEmail').value = c.billing_email || '';
  $('custInternalNotes').value = c.internal_notes || '';
  $('custTaxExempt').checked = !!c.tax_exempt;
  $('custTaxExemptNum').value = c.tax_exempt_number || '';
  $('custUnion').checked = !!c.union_required;
  $('custCertPayroll').checked = !!c.requires_certified_payroll;
  // Partner fields
  $('custPartnerLaborNotes').value = c.partner_labor_rate_notes || '';
  $('custPartnerBillingHours').value = c.partner_billing_hours || '48';
  $('custPartnerCheckin').value = c.partner_checkin_instructions || '';
  $('custPartnerWOInstructions').value = c.partner_work_order_instructions || '';
  $('custPartnerBillingNotes').value = c.partner_billing_notes || '';
  $('custPartnerBillingEmail').value = c.partner_billing_email || '';
  const spEl = $('custSalesperson');
  if (spEl) spEl.value = c.assigned_salesperson_id || 0;
  togglePartnerFields();
  openModal('customerModal');
}

function togglePartnerFields() {
  const isPartner = $('custType').value === 'Partner Door Company';
  $('partnerFields').style.display = isPartner ? 'block' : 'none';
}

async function saveCustomer() {
  const id = $('custModalId').value;
  const payload = {
    company_name: $('custName').value.trim(),
    customer_type: $('custType').value,
    is_partner_company: $('custType').value === 'Partner Door Company',
    qb_customer_id: $('custQbId').value.trim(),
    credit_terms: $('custTerms').value,
    billing_address: $('custBillingAddr').value,
    billing_city: $('custBillingCity').value,
    billing_state: $('custBillingState').value.toUpperCase(),
    billing_zip: $('custBillingZip').value,
    billing_phone: $('custBillingPhone').value,
    billing_fax: $('custBillingFax').value,
    billing_email: $('custBillingEmail').value,
    tax_exempt: $('custTaxExempt').checked,
    tax_exempt_number: $('custTaxExemptNum').value,
    union_required: $('custUnion').checked,
    requires_certified_payroll: $('custCertPayroll').checked,
    partner_labor_rate_notes: $('custPartnerLaborNotes').value,
    partner_billing_hours: parseInt(($('custPartnerBillingHours') && $('custPartnerBillingHours').value) || '48') || 48,
    partner_checkin_instructions: $('custPartnerCheckin').value,
    partner_work_order_instructions: $('custPartnerWOInstructions').value,
    partner_billing_notes: $('custPartnerBillingNotes').value,
    partner_billing_email: $('custPartnerBillingEmail').value,
    internal_notes: $('custInternalNotes').value,
    assigned_salesperson_id: parseInt($('custSalesperson').value) || 0,
    status: 'active'
  };
  if (!payload.company_name) return showToast('Company name is required.', 'error');
  try {
    if (id) {
      await api('PUT', '/api/customers/' + id, payload);
      showToast('Customer updated!', 'success');
      closeModal('customerModal');
      currentCustomerData = null;
      await loadCustomerDetail();
    } else {
      const r = await api('POST', '/api/customers', payload);
      showToast('Customer added!', 'success');
      closeModal('customerModal');
      openCustomerDetail(r.id);
    }
    loadCustomers();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── SITES ────────────────────────────────────────────────────────────────────
function openAddSite() {
  $('siteModalId').value = '';
  $('siteModalTitle').textContent = 'Add Site';
  ['siteName','siteStoreNum','siteAddr','siteCity','siteState','siteZip','siteNotes','siteAccess'].forEach(id => { const el=$(id); if(el) el.value=''; });
  openModal('siteModal');
}

function openEditSite(siteId) {
  const s = custSitesList.find(x => x.id === siteId);
  if (!s) return;
  $('siteModalId').value = s.id;
  $('siteModalTitle').textContent = 'Edit Site';
  $('siteName').value = s.site_name || '';
  $('siteStoreNum').value = s.store_number || '';
  $('siteAddr').value = s.address || '';
  $('siteCity').value = s.city || '';
  $('siteState').value = s.state || '';
  $('siteZip').value = s.zip || '';
  $('siteNotes').value = s.site_notes || '';
  $('siteAccess').value = s.access_instructions || '';
  openModal('siteModal');
}

async function saveSite() {
  const id = $('siteModalId').value;
  const payload = {
    site_name: $('siteName').value.trim(),
    store_number: $('siteStoreNum').value.trim(),
    address: $('siteAddr').value,
    city: $('siteCity').value,
    state: $('siteState').value.toUpperCase(),
    zip: $('siteZip').value,
    site_notes: $('siteNotes').value,
    access_instructions: $('siteAccess').value
  };
  try {
    if (id) await api('PUT', '/api/customers/' + currentCustomerId + '/sites/' + id, payload);
    else await api('POST', '/api/customers/' + currentCustomerId + '/sites', payload);
    closeModal('siteModal');
    showToast('Site saved!', 'success');
    currentCustomerData = null;
    await loadCustomerDetail();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteSite(id) {
  if (!confirm('Remove this site?')) return;
  await api('DELETE', '/api/customers/' + currentCustomerId + '/sites/' + id);
  currentCustomerData = null;
  await loadCustomerDetail();
}

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
function openAddContact() {
  $('contactModalId').value = '';
  $('contactModalTitle').textContent = 'Add Contact';
  ['contactFirst','contactLast','contactTitle','contactPhone','contactPhone2','contactEmail','contactNotes'].forEach(id => { const el=$(id); if(el) el.value=''; });
  $('contactPrimary').checked = false;
  $('contactBilling').checked = false;
  const siteEl = $('contactSite');
  siteEl.innerHTML = '<option value="0">— All locations (corporate contact) —</option>' +
    custSitesList.map(s => `<option value="${s.id}">${s.site_name}</option>`).join('');
  openModal('contactModal');
}

async function saveContact() {
  const id = $('contactModalId').value;
  const payload = {
    first_name: $('contactFirst').value.trim(),
    last_name: $('contactLast').value.trim(),
    title: $('contactTitle').value,
    phone: $('contactPhone').value,
    phone2: $('contactPhone2').value,
    email: $('contactEmail').value,
    site_id: parseInt($('contactSite').value) || 0,
    is_primary: $('contactPrimary').checked,
    is_billing_contact: $('contactBilling').checked,
    notes: $('contactNotes').value
  };
  if (!payload.first_name) return showToast('First name required.', 'error');
  try {
    if (id) await api('PUT', '/api/customers/' + currentCustomerId + '/contacts/' + id, payload);
    else await api('POST', '/api/customers/' + currentCustomerId + '/contacts', payload);
    closeModal('contactModal');
    showToast('Contact saved!', 'success');
    currentCustomerData = null;
    await loadCustomerDetail();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteContact(id) {
  if (!confirm('Remove this contact?')) return;
  await api('DELETE', '/api/customers/' + currentCustomerId + '/contacts/' + id);
  currentCustomerData = null;
  await loadCustomerDetail();
}

// ─── EQUIPMENT ────────────────────────────────────────────────────────────────
function openAddEquipment() {
  $('equipModalId').value = '';
  $('equipModalTitle').textContent = 'Add Equipment';
  ['equipMfr','equipModel','equipSerial','equipSize','equipInstall','equipWarranty','equipLocation','equipNotes'].forEach(id => { const el=$(id); if(el) el.value=''; });
  $('equipCondition').value = 'Good';
  const siteEl = $('equipSite');
  siteEl.innerHTML = '<option value="0">— Not site-specific —</option>' +
    custSitesList.map(s => `<option value="${s.id}">${s.site_name}</option>`).join('');
  openModal('equipmentModal');
}

async function saveEquipment() {
  const id = $('equipModalId').value;
  const payload = {
    equipment_type: $('equipType').value,
    site_id: parseInt($('equipSite').value) || 0,
    manufacturer: $('equipMfr').value,
    model: $('equipModel').value,
    serial_number: $('equipSerial').value,
    size: $('equipSize').value,
    install_date: $('equipInstall').value,
    warranty_expiry: $('equipWarranty').value,
    condition: $('equipCondition').value,
    location_in_site: $('equipLocation').value,
    notes: $('equipNotes').value
  };
  try {
    if (id) await api('PUT', '/api/customers/' + currentCustomerId + '/equipment/' + id, payload);
    else await api('POST', '/api/customers/' + currentCustomerId + '/equipment', payload);
    closeModal('equipmentModal');
    showToast('Equipment saved!', 'success');
    currentCustomerData = null;
    await loadCustomerDetail();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteEquipment(id) {
  if (!confirm('Remove this equipment record?')) return;
  await api('DELETE', '/api/customers/' + currentCustomerId + '/equipment/' + id);
  currentCustomerData = null;
  await loadCustomerDetail();
}

// ─── PARTNER DOCS ─────────────────────────────────────────────────────────────
async function savePartnerDoc() {
  const docType = $('partnerDocType').value;
  const docName = $('partnerDocName').value.trim();
  const notes   = $('partnerDocNotes').value;
  const file    = $('partnerDocFile').files[0];
  if (!docName) return showToast('Enter a document name.', 'error');
  if (!file) return showToast('Select a file.', 'error');
  const prog = $('partnerDocProgress');
  prog.style.display = 'block'; prog.textContent = 'Uploading...';
  try {
    const b64 = await fileToBase64(file);
    await api('POST', '/api/customers/' + currentCustomerId + '/docs', {
      doc_type: docType, doc_name: docName, notes,
      file_name: file.name, file_data: b64, file_type: file.type, file_size: file.size
    });
    prog.style.display = 'none';
    closeModal('partnerDocModal');
    showToast('Document uploaded!', 'success');
    currentCustomerData = null;
    await loadCustomerDetail();
  } catch(e) { prog.style.display = 'none'; showToast(e.message, 'error'); }
}

async function deletePartnerDoc(id) {
  if (!confirm('Delete this document?')) return;
  await api('DELETE', '/api/customers/' + currentCustomerId + '/docs/' + id);
  currentCustomerData = null;
  await loadCustomerDetail();
}

// ─── QB EXPORT ────────────────────────────────────────────────────────────────
function exportQBIIF() {
  window.open('/api/customers/export/qb-iif', '_blank');
  showToast('QB IIF file downloading. Import into QuickBooks Desktop via File → Utilities → Import → IIF Files.', 'success');
}
