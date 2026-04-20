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
  const u = currentUser;
  const role = u.role_type || 'technician';
  const isAdmin   = ['global_admin','admin'].includes(role);
  const isManager = ['global_admin','admin','manager'].includes(role);

  // Topbar
  const av = $('topAvatar');
  if (av) { av.textContent = initials(u.first_name, u.last_name); av.style.background = u.avatar_color || avatarBg(u.first_name+u.last_name); }
  if ($('topName')) $('topName').textContent = u.first_name;

  // Admin sidebar section — managers and above only
  const adminSection = $('adminSection');
  if (adminSection) adminSection.style.display = isManager ? 'block' : 'none';

  // Admin action buttons — admins only
  if (isAdmin) {
    ['btnNewAnn','btnNewNews','btnNewOncall','btnAutoSchedule','btnLoadSchedule','btnUploadPolicy'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'inline-flex';
    });
    const allDocsSection = $('allDocsSection');
    if (allDocsSection) allDocsSection.style.display = 'block';
  }

  // All employees see customers
  document.querySelectorAll('.nav-item[data-page="customers"]').forEach(el => el.style.display='flex');

  // Time Off Calendar — managers and above only (it's in admin section but double-check)
  // Admin section already handles this since ptoCalendar is inside adminSection

  updatePtoBadge();
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
  const map={dashboard:renderDashboard,customers:loadCustomers,customerDetail:loadCustomerDetail,projects:loadProjects,projectDetail:loadProjectDetail,quickJobs:loadQuickJobs,quickJobDetail:loadQuickJobDetail,sales:quotesShowList,myTimecards:renderMyTimecards,announcements:renderAnnouncements,news:renderNews,oncall:renderOncall,directory:renderDirectory,pto:renderPto,ptoCalendar:renderPtoCalendar,myDocs:renderMyDocs,policies:renderPolicies,timeclock:initTimeclock,adminTimeclock:loadAdminTimecards,adminAlerts:renderAlerts,adminAttendance:initAdminAttendance,adminUsers:renderAdminUsers,adminPto:renderAdminPto,adminBlackout:renderBlackouts,adminRotation:renderRotation,adminSettings:loadSettings};
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
    // Load manager-only attendance brief
    loadAttendanceBrief();
    // Load achievements
    loadMyAchievements();
  } catch(e){ console.error(e); }
}

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
function annItemHTML(a, showDelete) {
  const cls=a.priority==='urgent'?'urgent':a.priority==='info'?'info':'';
  const bc=a.priority==='urgent'?'badge-red':a.priority==='info'?'badge-blue':'badge-gray';
  return `<div class="ann-item ${cls}"><div class="ann-item-head"><span class="ann-title">${a.title}</span><span class="badge ${bc}">${a.priority}</span>${showDelete&&['global_admin','admin'].includes(currentUser.role_type||'')?`<button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="deleteAnnouncement(${a.id})">Delete</button>`:''}</div><div class="ann-body">${a.body}</div><div class="ann-meta">${a.author_name} &middot; ${fmtDate(a.created_at)}</div></div>`;
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
  return `<div class="news-item"><div class="news-icon">${catIcons[n.category]||'📰'}</div><div style="flex:1"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div class="news-title">${n.title}</div>${showDelete&&['global_admin','admin'].includes(currentUser.role_type||'')?`<button class="btn btn-danger btn-sm" onclick="deleteNews(${n.id})">Delete</button>`:''}</div><div class="news-body">${n.body}</div><div class="news-meta"><span class="badge badge-green">${n.category}</span> &middot; ${n.author_name} &middot; ${fmtDate(n.created_at)}</div></div></div>`;
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
            ${['global_admin','admin'].includes(currentUser.role_type||'')?`<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:11px" onclick="openSwapOncall(${o.id},'${o.name}','${o.department}')">Swap</button><button class="btn btn-danger btn-sm" style="padding:2px 7px;font-size:11px" onclick="deleteOncall(${o.id})">✕</button>`:''}
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
  const fallback = allUsers.filter(u => !['global_admin','admin'].includes(u.role_type||''));

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
    return !['global_admin','admin'].includes(u.role_type||'');
  });
  const list = relevant.length ? relevant : allUsers.filter(u => !['global_admin','admin'].includes(u.role_type||''));
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
      const dirRole = currentUser.role_type||'technician';
    const dirIsManager = ['global_admin','admin','manager'].includes(dirRole);
    return `<div class="dir-card"><div class="dir-card-top"><div class="avatar" style="width:44px;height:44px;font-size:15px;background:${ac}">${initials(u.first_name,u.last_name)}</div><div><div style="font-weight:500;font-size:13.5px;font-family:Oswald,sans-serif">${name}</div><div style="font-size:11px;color:var(--text-muted)">${u.role||'—'}</div>${deptBadge}</div></div><div class="dir-info" style="margin-top:8px"><div>📞 ${u.phone||'—'}</div><div>✉ ${u.email||'—'}</div><div>🏢 ${u.department||'—'}</div>${dirIsManager&&u.hire_date?'<div class="dir-hire-date">📅 Hired: '+fmtDate(u.hire_date)+'</div>':''}</div></div>`;
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
    // Always refresh from server when page loads
    allUsers = await api('GET', '/api/users');
    renderEmployeeRows(allUsers);
  } catch(e){ console.error(e); }
}

function filterEmployeeTable() {
  if (!allUsers.length) { renderAdminUsers(); return; }
  const searchQ = ($('empSearchInput') && $('empSearchInput').value || '').toLowerCase();
  const deptF   = ($('empDeptFilter')  && $('empDeptFilter').value)  || '';
  let filtered  = allUsers;
  if (searchQ) filtered = filtered.filter(u =>
    (u.first_name||'').toLowerCase().includes(searchQ) ||
    (u.last_name||'').toLowerCase().includes(searchQ) ||
    (u.username||'').toLowerCase().includes(searchQ)
  );
  if (deptF) filtered = filtered.filter(u => (u.department||'') === deptF || (u.department||'').toLowerCase().includes(deptF.toLowerCase()));
  renderEmployeeRows(filtered);
}

function renderEmployeeRows(filtered) {
  const countEl = $('empFilterCount');
  if (countEl) countEl.textContent = filtered.length + ' of ' + allUsers.length + ' employees';
  if (!$('usersTbody')) return;
  $('usersTbody').innerHTML=filtered.map(u=>{
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
}
async function saveUser() {
  const first_name=$('addFirst').value.trim(),last_name=$('addLast').value.trim();
  const username=$('addUsername').value.trim(),password=$('addPass').value;
  if(!first_name||!username||!password) return showToast('Fill in required fields.','error');
  try {
    await api('POST','/api/users',{username,password,first_name,last_name,role:$('addRole').value,department:$('addDept').value,oncall_dept:$('addOncallDept').value,oncall_role:$('addOncallRole').value,phone:$('addPhone').value,email:$('addEmail').value,is_admin:['admin','global_admin'].includes($('addRoleType').value),role_type:$('addRoleType')?$('addRoleType').value:'technician',pto_total:parseInt($('addPtoTotal').value)||10,pto_left:parseInt($('addPtoLeft').value)||10,hire_date:$('addHireDate').value||'',avatar_color:avatarBg(first_name+last_name)});
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
    if(s.po_format&&$('poFormat')) $('poFormat').value=s.po_format;
    if(s.po_prefix&&$('poPrefix')) $('poPrefix').value=s.po_prefix||'';
    updatePoPreview();
  } catch(e){}
}
async function saveSmtpSettings() {
  try { await api('POST','/api/settings',{smtp_host:$('smtpHost').value,smtp_port:$('smtpPort').value,smtp_user:$('smtpUser').value,smtp_pass:$('smtpPass').value,smtp_from_name:$('smtpFromName').value}); showToast('Email settings saved!','success'); } catch(e){showToast(e.message,'error');}
}
async function savePoSettings() {
  const fmt = ($('poFormat')&&$('poFormat').value.trim())||'MMYY-###';
  const pfx = ($('poPrefix')&&$('poPrefix').value.trim())||'';
  try { await api('POST','/api/settings',{po_format:fmt,po_prefix:pfx}); showToast('PO settings saved!','success'); updatePoPreview(); } catch(e){showToast(e.message,'error');}
}
function updatePoPreview() {
  const el=$('poFormatPreview'); if(!el) return;
  const fmt=($('poFormat')&&$('poFormat').value)||'MMYY-###';
  const pfx=($('poPrefix')&&$('poPrefix').value)||'';
  const now=new Date(); const mm=String(now.getMonth()+1).padStart(2,'0'); const yy=String(now.getFullYear()).slice(-2);
  const hc=(fmt.match(/#+/)||['###'])[0].length;
  let ex=fmt.replace('MMYY',mm+yy).replace('MM',mm).replace('YY',yy).replace(/#+/,'1'.padStart(hc,'0'));
  el.textContent='Preview: '+(pfx||'')+ex+', '+(pfx||'')+ex.replace(/\d+$/, n=>String(parseInt(n)+1).padStart(hc,'0'));
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
  // Set department dropdown
  const editDeptEl = $('editDept');
  if (editDeptEl) {
    editDeptEl.value = u.department || '';
    // If value not in options, add it temporarily
    if (editDeptEl.value !== (u.department||'') && u.department) {
      const opt = document.createElement('option');
      opt.value = u.department; opt.textContent = u.department;
      editDeptEl.appendChild(opt);
      editDeptEl.value = u.department;
    }
  }
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
  const limitedMode = !['global_admin','admin'].includes(currentUser.role_type||'') && currentUser.role_type === 'manager';
  ['editUsername','editRoleType','editPtoTotal','editPtoLeft','editHireDate'].forEach(fid => {
    const el = $(fid);
    if (el) { el.disabled = limitedMode; el.style.opacity = limitedMode ? '0.4' : '1'; el.title = limitedMode ? 'Admin only' : ''; }
  });
  const adminNote = $('editAdminOnlyNote');
  if (adminNote) adminNote.style.display = limitedMode ? 'block' : 'none';

  // Phase 1A: Load skills, labor rate, sales department
  try {
    const ext = await api('GET', '/api/users/' + u.id + '/extended');
    renderSkillsCheckboxes('edit', ext.skills || []);
    if ($('editLaborRate')) $('editLaborRate').value = ext.labor_rate_burdened || '';
    if ($('editSalesDept')) $('editSalesDept').value = ext.sales_department || '';
    const meta = $('editLaborRateMeta');
    if (meta) {
      if (ext.labor_rate_updated_at) {
        meta.textContent = 'Last updated ' + fmtDate(ext.labor_rate_updated_at) + (ext.labor_rate_updated_by_name ? ' by ' + ext.labor_rate_updated_by_name : '');
      } else {
        meta.textContent = 'Not set yet.';
      }
    }
    const checkAll = $('editSkillsCheckAll');
    if (checkAll) checkAll.checked = false;
  } catch(e) {
    // Manager may not have permission; render empty
    renderSkillsCheckboxes('edit', []);
  }

  openModal('editUserModal');
}

async function saveEditUser() {
  const id = $('editUserId').value;
  const isAdmin = ['global_admin','admin'].includes(currentUser.role_type||'');
  const limitedMode = !isAdmin && currentUser.role_type === 'manager';
  const first_name = $('editFirst').value.trim();
  const username   = $('editUsername').value.trim();
  if (!first_name || !username) return showToast('First name and username are required.', 'error');

  try {
    const newRoleType = $('editRoleType') ? $('editRoleType').value : 'technician';
    await api('PUT', '/api/users/' + id, {
      first_name,
      last_name:    $('editLast').value.trim(),
      role_type:    newRoleType,
      username,
      role:         $('editRole').value,
      department:   $('editDept').value,
      oncall_dept:  $('editOncallDept') ? $('editOncallDept').value : '',
      oncall_role:  $('editOncallRole') ? $('editOncallRole').value : '',
      phone:        $('editPhone').value,
      email:        $('editEmail').value,
      pto_total:    parseInt($('editPtoTotal').value) || 10,
      pto_left:     parseInt($('editPtoLeft').value)  || 10,
      hire_date:    $('editHireDate').value || '',
    });
    closeModal('editUserModal');
    allUsers = []; // clear cache so next load is fresh
    showToast('Employee updated!', 'success');
    // Phase 1A: save extended fields (skills, labor rate, sales dept)
    try {
      const selectedSkills = collectCheckedSkills('edit');
      await api('PUT', '/api/users/' + id + '/skills', { skills: selectedSkills });
      const laborInput = $('editLaborRate');
      if (laborInput && laborInput.value !== '') {
        await api('PUT', '/api/users/' + id + '/labor-rate', { labor_rate_burdened: parseFloat(laborInput.value)||0 });
      }
      const salesDept = $('editSalesDept') ? $('editSalesDept').value : '';
      await api('PUT', '/api/users/' + id + '/sales-dept', { sales_department: salesDept });
    } catch(e) { /* silent — extended fields optional */ }
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

  // Load ALL approved PTO
  let allPto = [];
  try { allPto = await api('GET', '/api/pto/all-approved'); } catch(e) {}
  const approved = allPto.filter(r => r.status === 'approved');
  
  // Also load call-ins and add to calendar
  let callinEvents = [];
  try {
    const myCallin = await api('GET', '/api/attendance/my-callins');
    myCallin.callins.forEach(c => {
      callinEvents.push({
        start_date: c.call_in_date, end_date: c.call_in_date,
        days: 1, type: c.call_in_type, status: 'approved',
        user_id: currentUser.id, user_name: currentUser.first_name + ' ' + (currentUser.last_name||'')
      });
    });
  } catch(e) {}
  const allEvents = [...approved, ...callinEvents];

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
    allEvents.forEach(r => {
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
    const inMonth = allEvents.filter(r => r.start_date <= monthEnd && r.end_date >= monthStart);
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
    if (['global_admin','admin'].includes(currentUser.role_type||'')) renderAllDocs();
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
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div>' + (['global_admin','admin'].includes(currentUser.role_type||'') ? 'No policy documents yet. Click "+ Add Document" to upload.' : 'No policy documents have been published yet.') + '</div>';
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
              ${['global_admin','admin'].includes(currentUser.role_type||'') ? `<button class="btn btn-danger btn-sm" onclick="deletePolicy(${p.id})">Delete</button>` : ''}
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
  const selEl = $('clockTypeSelect'); if (!selEl) return;
  const type = selEl.value;
  const jf = $('jobFields');    if (jf) jf.style.display    = (type === 'field' || type === 'union') ? 'block' : 'none';
  const uf = $('unionFields');  if (uf) uf.style.display    = type === 'union' ? 'block' : 'none';
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
  const empOpts = allUsers.filter(u=>!['global_admin','admin'].includes(u.role_type||'')).map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join('');
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

// Wrapper to open callin modal with employees populated
async function openCallinModal() {
  if (!allUsers.length) try { allUsers = await api('GET', '/api/users'); } catch(e){}
  const empOpts = allUsers.filter(u => !['global_admin','admin'].includes(u.role_type||'')).map(u =>
    `<option value="${u.id}">${displayName(u)}</option>`).join('');
  const sel = $('callinEmpSelect');
  if (sel) sel.innerHTML = empOpts;
  const dateEl = $('callinDate');
  if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
  const notesEl = $('callinNotes');
  if (notesEl) notesEl.value = '';
  openModal('callinModal');
}

// Wrapper to open attendance event modal with employees populated
async function openAttEventModal() {
  if (!allUsers.length) try { allUsers = await api('GET', '/api/users'); } catch(e){}
  const empOpts = allUsers.filter(u => !['global_admin','admin'].includes(u.role_type||'')).map(u =>
    `<option value="${u.id}">${displayName(u)}</option>`).join('');
  const sel = $('attEventEmp');
  if (sel) sel.innerHTML = empOpts;
  const dateEl = $('attEventDate');
  if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
  const notesEl = $('attEventNotes');
  if (notesEl) notesEl.value = '';
  const minsEl = $('attEventMins');
  if (minsEl) minsEl.value = '0';
  openModal('attendanceEventModal');
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
    const printBtn = $('btnPrintReport');
    if (printBtn) printBtn.style.display = 'inline-flex';
  } catch(e) { el.innerHTML = '<div class="empty-state">Error loading report.</div>'; }
}

function printQuarterlyReport() {
  const quarter = $('reportQuarter') ? $('reportQuarter').value : '';
  const year    = $('reportYear') ? $('reportYear').value : '';
  const content = $('quarterlyReportContent');
  if (!content || !content.innerHTML) return showToast('Generate the report first.','error');
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>KVM Attendance Report — ${quarter} ${year}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #000; margin: 20px; }
    h1 { color: #000; font-size: 18px; margin-bottom: 4px; }
    h2 { font-size: 14px; color: #333; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
    th { background: #f0f0f0; padding: 8px; text-align: left; border: 1px solid #ccc; font-weight: bold; }
    td { padding: 7px 8px; border: 1px solid #ddd; }
    tr:nth-child(even) td { background: #f9f9f9; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .perfect { background: #fff3cd; color: #856404; border: 1px solid #ffc107; }
    .review  { background: #f8d7da; color: #842029; border: 1px solid #f5c2c7; }
    .monitor { background: #fff3cd; color: #664d03; border: 1px solid #ffda6a; }
    .good    { background: #d1e7dd; color: #0f5132; border: 1px solid #a3cfbb; }
    .perfect-block { background: #fff3cd; border: 2px solid #ffc107; border-radius: 6px; padding: 12px; margin-bottom: 16px; }
    @media print { body { margin: 10px; } button { display: none !important; } }
  </style></head><body>
  <div style="display:flex;align-items:center;gap:16px;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px">
    <div><h1>KVM DOOR SYSTEMS</h1><h2>Quarterly Attendance Report — ${quarter} ${year}</h2></div>
    <div style="margin-left:auto;font-size:11px;color:#666">Generated: ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
  </div>
  ${content.innerHTML}
  <script>window.onload=()=>window.print();</script>
  </body></html>`);
  win.document.close();
}

async function runPerfectAttendanceCheck() {
  const el = $('perfectAttContent');
  if (el) el.innerHTML = '<div style="color:var(--text-muted);padding:1rem 0">Checking attendance records...</div>';
  openModal('perfectAttendanceModal');
  try {
    // Get all employees and their attendance for current quarter
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3) + 1;
    const year = now.getFullYear();
    const qStart = new Date(year, (q-1)*3, 1).toISOString().split('T')[0];
    const qEnd = new Date(year, q*3, 0).toISOString().split('T')[0];

    const [users, callins, events] = await Promise.all([
      api('GET', '/api/users'),
      api('GET', '/api/attendance/callins-range?start=' + qStart + '&end=' + qEnd).catch(()=>[]),
      api('GET', '/api/attendance/events-range?start=' + qStart + '&end=' + qEnd).catch(()=>[])
    ]);

    const employees = users.filter(u => !['global_admin','admin'].includes(u.role_type||''));
    const callinsByEmp = {};
    const eventsByEmp = {};
    (Array.isArray(callins) ? callins : []).forEach(c => { if (!callinsByEmp[c.user_id]) callinsByEmp[c.user_id] = []; callinsByEmp[c.user_id].push(c); });
    (Array.isArray(events) ? events : []).forEach(e => { if (!eventsByEmp[e.user_id]) eventsByEmp[e.user_id] = []; eventsByEmp[e.user_id].push(e); });

    const perfect = employees.filter(u => !(callinsByEmp[u.id]||[]).length && !(eventsByEmp[u.id]||[]).length);
    const hasConcerns = employees.filter(u => (callinsByEmp[u.id]||[]).length + (eventsByEmp[u.id]||[]).length > 0)
      .sort((a,b) => ((callinsByEmp[b.id]||[]).length + (eventsByEmp[b.id]||[]).length) - ((callinsByEmp[a.id]||[]).length + (eventsByEmp[a.id]||[]).length));

    if (el) el.innerHTML = `
      <div style="margin-bottom:1rem">
        <div style="font-family:Oswald,sans-serif;font-size:13px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem">
          Q${q} ${year} — ${qStart} to ${qEnd}
        </div>
      </div>
      <div style="margin-bottom:1.25rem">
        <div style="font-family:Oswald,sans-serif;font-size:15px;color:var(--amber);margin-bottom:.75rem">
          &#127942; Perfect Attendance (${perfect.length} employees)
        </div>
        ${perfect.length ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${perfect.map(u=>`
          <div style="background:var(--amber-bg2);border:1px solid var(--amber-dim);border-radius:6px;padding:6px 12px;font-size:13px;font-weight:600">
            ${displayName(u)}
          </div>`).join('')}</div>` : '<div style="color:var(--text-faint);font-size:13px">No employees with perfect attendance this quarter.</div>'}
      </div>
      ${hasConcerns.length ? `<div>
        <div style="font-family:Oswald,sans-serif;font-size:15px;color:var(--danger);margin-bottom:.75rem">
          Attendance Concerns (${hasConcerns.length} employees)
        </div>
        <table class="data-table">
          <thead><tr><th>Employee</th><th>Call-Ins</th><th>Events (Tardy/NCNS)</th><th>Total</th></tr></thead>
          <tbody>${hasConcerns.map(u => {
            const ci = (callinsByEmp[u.id]||[]).length;
            const ev = (eventsByEmp[u.id]||[]).length;
            return `<tr>
              <td><strong>${displayName(u)}</strong></td>
              <td>${ci ? `<span style="color:var(--amber)">${ci}</span>` : '—'}</td>
              <td>${ev ? `<span style="color:var(--danger)">${ev}</span>` : '—'}</td>
              <td><strong>${ci+ev}</strong></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>` : ''}`;

    const btnPost = $('btnPostPerfect');
    const btnPrint = $('btnPrintPerfect');
    if (btnPost) { btnPost.style.display = perfect.length ? 'inline-flex' : 'none'; btnPost._perfectList = perfect; }
    if (btnPrint) btnPrint.style.display = 'inline-flex';

    // Also run the server-side check
    try { await api('POST', '/api/attendance/perfect-check', {}); } catch(e) {}
  } catch(e) {
    if (el) el.innerHTML = '<div style="color:var(--danger)">Error loading attendance data: ' + e.message + '</div>';
  }
}

async function postPerfectAttendance() {
  const btn = $('btnPostPerfect');
  const perfect = btn && btn._perfectList;
  if (!perfect || !perfect.length) return;
  const names = perfect.map(u => displayName(u)).join(', ');
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  try {
    await api('POST', '/api/announcements', {
      title: `&#127942; Q${q} Perfect Attendance Recognition`,
      body: `Congratulations to the following employees for achieving perfect attendance this quarter: ${names}. Thank you for your dedication and reliability!`,
      priority: 'info'
    });
    showToast('Perfect attendance posted to announcements!', 'success');
    closeModal('perfectAttendanceModal');
  } catch(e) { showToast(e.message, 'error'); }
}

function printPerfectAttendance() {
  const el = $('perfectAttContent');
  if (!el) return;
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>KVM Perfect Attendance Report</title>
  <style>body{font-family:Arial,sans-serif;margin:24px;color:#000}h1{font-size:18px;margin-bottom:4px}
  h2{font-size:14px;color:#555;margin-bottom:16px}table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f0f0f0;padding:8px;text-align:left;border:1px solid #ccc}
  td{padding:7px 8px;border:1px solid #ddd}@media print{button{display:none}}</style></head>
  <body><h1>KVM Door Systems — Attendance Report</h1><h2>Generated ${new Date().toLocaleDateString()}</h2>
  ${el.innerHTML}<script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
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
      allUsers.filter(u=>['sales','manager','global_admin','admin'].includes(u.role_type||'')).map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join('');
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
  if($('custServiceAddr')) $('custServiceAddr').value = c.service_address||'';
  if($('custServiceCity')) $('custServiceCity').value = c.service_city||'';
  if($('custServiceState')) $('custServiceState').value = c.service_state||'';
  if($('custServiceZip')) $('custServiceZip').value = c.service_zip||'';
  if($('custServiceEmail')) $('custServiceEmail').value = c.service_email||'';
  if($('custSmsNumber')) $('custSmsNumber').value = c.sms_number||'';
  if($('custAltContact')) $('custAltContact').value = c.alt_contact_name||'';
  if($('custAltPhone')) $('custAltPhone').value = c.alt_contact_phone||'';
  if($('custCreditLimit')) $('custCreditLimit').value = c.credit_limit||0;
  if($('custPriceLevel')) $('custPriceLevel').value = c.price_level||'';
  if($('custMapCode')) $('custMapCode').value = c.map_code||'';
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
  const typeEl = $('custType');
  const pfEl = $('partnerFields');
  if (!typeEl || !pfEl) return;
  pfEl.style.display = typeEl.value === 'Partner Door Company' ? 'block' : 'none';
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
    service_address: $('custServiceAddr').value,
    service_city: $('custServiceCity').value,
    service_state: ($('custServiceState').value||'').toUpperCase(),
    service_zip: $('custServiceZip').value,
    service_email: $('custServiceEmail').value,
    alt_contact_name: $('custAltContact').value,
    alt_contact_phone: $('custAltPhone').value,
    sms_number: $('custSmsNumber').value,
    credit_limit: parseFloat($('custCreditLimit').value)||0,
    price_level: $('custPriceLevel').value,
    map_code: $('custMapCode').value,
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

// ─── MY TIMECARDS PAGE ────────────────────────────────────────────────────────
async function renderMyTimecards() {
  const wkEl = $('myTcWeekPicker');
  const weekVal = getCurrentWeekValue();
  if (wkEl) wkEl.value = wkEl.value || weekVal;
  await loadMyTimecardPage();
}

async function loadMyTimecardPage() {
  const wkEl = $('myTcWeekPicker');
  const body = $('myTcBody');
  const summary = $('myTcSummary');

  // Calculate Monday of selected week (or current week)
  let weekMonday;
  if (wkEl && wkEl.value) {
    const [yr, wk] = wkEl.value.split('-W');
    // ISO week to date: Jan 4 is always in week 1
    const jan4 = new Date(parseInt(yr), 0, 4);
    const dayOfWeek = jan4.getDay() || 7; // treat Sunday as 7
    weekMonday = new Date(jan4);
    weekMonday.setDate(jan4.getDate() - dayOfWeek + 1 + (parseInt(wk) - 1) * 7);
  } else {
    // Current week Monday
    const today = new Date();
    const day = today.getDay() || 7;
    weekMonday = new Date(today);
    weekMonday.setDate(today.getDate() - day + 1);
  }
  const ws = weekMonday.toISOString().split('T')[0];

  if (body) body.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:1rem 0">Loading...</div>';

  try {
    const entries = await api('GET', `/api/timeclock/my?week=${ws}`);
    if (!entries || !entries.length) {
      if (body) body.innerHTML = '<div class="empty-state">No time entries for this week.</div>';
      if (summary) summary.innerHTML = '';
      return;
    }
    let totalMins = 0;
    if (body) body.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Type</th><th>Clock In</th><th>Clock Out</th><th>Hours</th><th>Job / Location</th></tr></thead>
      <tbody>${entries.map(e => {
        const mins = e.total_minutes || 0;
        totalMins += mins;
        const typeLabel = e.clock_type === 'shop' ? '🏭 Shop' : e.clock_type === 'union' ? '🤝 Union' : '📍 Field';
        const clockIn = e.clock_in ? new Date(e.clock_in) : null;
        const clockOut = e.clock_out ? new Date(e.clock_out) : null;
        return `<tr>
          <td>${clockIn ? clockIn.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}) : '—'}</td>
          <td style="font-size:12px">${typeLabel}</td>
          <td>${clockIn ? clockIn.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}) : '—'}</td>
          <td>${clockOut ? clockOut.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}) : '<span class="badge badge-green" style="font-size:10px">Active</span>'}</td>
          <td><strong>${(mins/60).toFixed(2)}</strong> hrs</td>
          <td style="font-size:12px;color:var(--text-muted)">${e.job_name || e.customer || '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
    const reg = Math.min(totalMins, 2400);
    const ot = Math.max(0, totalMins - 2400);
    if (summary) summary.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:1rem">
      <div class="stat-card"><div class="stat-label">Regular</div><div class="stat-value">${(reg/60).toFixed(2)} hrs</div></div>
      <div class="stat-card"><div class="stat-label">Overtime</div><div class="stat-value" style="color:${ot>0?'var(--danger)':'var(--green)'}">${(ot/60).toFixed(2)} hrs</div></div>
      <div class="stat-card"><div class="stat-label">Total This Week</div><div class="stat-value" style="color:var(--amber)">${(totalMins/60).toFixed(2)} hrs</div></div>
    </div>`;
  } catch(e) {
    console.error('My Timecards error:', e);
    if (body) body.innerHTML = '<div class="empty-state">Error loading timecards: ' + e.message + '</div>';
  }
}

async function openAwardAchievement() {
  if (!allUsers.length) try { allUsers = await api('GET','/api/users'); } catch(e){}
  $('achEmployee').innerHTML = allUsers.map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join('');
  $('achTitle').value = '';
  $('achDesc').value = '';
  openModal('achievementModal');
}

async function saveAchievement() {
  const user_id = $('achEmployee').value;
  const title   = $('achTitle').value.trim();
  const icon    = $('achIcon').value;
  const description = $('achDesc').value;
  if (!title) return showToast('Enter an achievement title.','error');
  try {
    await api('POST','/api/achievements',{user_id,title,description,icon});
    closeModal('achievementModal');
    showToast('Achievement awarded! 🏆','success');
  } catch(e) { showToast(e.message,'error'); }
}

// Load achievements on dashboard
async function loadMyAchievements() {
  try {
    const achievements = await api('GET','/api/achievements/my');
    const el = $('myAchievements');
    if (!el || !achievements.length) return;
    el.innerHTML = `<div class="card-header" style="margin-bottom:.75rem"><span class="card-title">&#127942; My Achievements</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${achievements.map(a=>`<div style="background:var(--amber-bg2);border:1px solid var(--amber-dim);border-radius:8px;padding:10px 14px;display:flex;align-items:flex-start;gap:10px">
          <span style="font-size:24px">${a.icon}</span>
          <div><div style="font-family:Oswald,sans-serif;font-size:14px;font-weight:600;color:var(--amber)">${a.title}</div>
          ${a.description?`<div style="font-size:12px;color:var(--text-muted)">${a.description}</div>`:''}
          <div style="font-size:10px;color:var(--text-faint);margin-top:3px">Awarded by ${a.awarded_by} &middot; ${fmtDate(a.awarded_at)}</div></div>
        </div>`).join('')}
      </div>`;
  } catch(e) {}
}

// ─── QB BULK IMPORT ───────────────────────────────────────────────────────────
async function runQBImport() {
  const content = $('qbImportContent').value.trim();
  if (!content) return showToast('Paste your IIF file contents first.','error');
  const resultEl = $('qbImportResult');
  resultEl.className = 'alert alert-warning';
  resultEl.textContent = 'Importing...';
  resultEl.style.display = 'block';
  try {
    const r = await api('POST','/api/customers/import/qb-iif',{iif_content: content});
    resultEl.className = 'alert alert-success';
    resultEl.textContent = `✓ Import complete: ${r.imported} customers added, ${r.skipped} already existed.${r.errors.length?' Some errors: '+r.errors.join(', '):''}`;
    if (r.imported > 0) loadCustomers();
  } catch(e) {
    resultEl.className = 'alert alert-danger';
    resultEl.textContent = '✗ ' + e.message;
  }
}

// ─── DAILY ATTENDANCE BRIEF ───────────────────────────────────────────────────
async function loadAttendanceBrief() {
  const role = currentUser.role_type || 'technician';
  const isManager = ['global_admin','admin','manager'].includes(role);
  const briefEl = $('dailyAttendanceBrief');
  if (!briefEl || !isManager) return;
  briefEl.style.display = 'block';

  // Set date
  const now = new Date();
  const dateEl = $('attendanceBriefDate');
  if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  });

  await refreshAttendanceBrief();
}

async function refreshAttendanceBrief() {
  const gridEl = $('attendanceBriefGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:.5rem 0">Loading...</div>';

  try {
    const today = new Date().toISOString().split('T')[0];
    if (!allUsers.length) try { allUsers = await api('GET', '/api/users'); } catch(e){}

    // Get today's clock-ins using the week start
    const d = new Date(today + 'T00:00:00');
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const weekMon = new Date(d); weekMon.setDate(d.getDate() + diff);
    const weekStr = weekMon.toISOString().split('T')[0];
    let clockedIn = [];
    try { clockedIn = await api('GET', `/api/timeclock/all?week=${weekStr}`); } catch(e) {}
    const clockedIds = new Set(clockedIn.filter(e => e.clock_in && e.clock_in.startsWith(today)).map(e => e.user_id));

    // Get today's call-ins
    let callins = [];
    try {
      const attData = await api('GET', '/api/attendance/all');
      callins = (attData.callins || []).filter(c => c.call_in_date === today);
    } catch(e) {}
    const callinIds = new Set(callins.map(c => c.user_id));

    // Get approved time off today
    let timeoff = [];
    try {
      const allPto = await api('GET', '/api/pto/all-approved');
      timeoff = allPto.filter(r => r.start_date <= today && r.end_date >= today);
    } catch(e) {}
    const timeoffIds = new Set(timeoff.map(r => r.user_id));

    // Only field/active employees (non-admin)
    const employees = allUsers.filter(u => !['global_admin','admin'].includes(u.role_type||''));

    const inGroup      = employees.filter(u => clockedIds.has(u.id) && !callinIds.has(u.id));
    const callinGroup  = employees.filter(u => callinIds.has(u.id));
    const timeoffGroup = employees.filter(u => timeoffIds.has(u.id) && !callinIds.has(u.id));
    const unknownGroup = employees.filter(u => !clockedIds.has(u.id) && !callinIds.has(u.id) && !timeoffIds.has(u.id));

    const makeChip = (u, color) => {
      const ac = u.avatar_color || avatarBg(u.first_name+(u.last_name||''));
      return `<div class="att-chip"><div class="att-chip-avatar" style="background:${ac}22;color:${ac}">${initials(u.first_name,u.last_name||'')}</div><span>${u.first_name}${u.last_name?' '+u.last_name.charAt(0)+'.':''}</span></div>`;
    };

    gridEl.innerHTML = `
      <div class="att-col att-col-in">
        <div class="att-col-header"><span class="att-dot" style="background:#27ae60"></span>Clocked In <span class="att-count">${inGroup.length}</span></div>
        <div class="att-chips">${inGroup.map(u=>makeChip(u,'#27ae60')).join('')||'<span class="att-none">None yet</span>'}</div>
      </div>
      <div class="att-col att-col-off">
        <div class="att-col-header"><span class="att-dot" style="background:#e67e22"></span>Called In <span class="att-count">${callinGroup.length}</span></div>
        <div class="att-chips">${callinGroup.map(u => {
          const ci = callins.find(c=>c.user_id===u.id);
          return `<div class="att-chip"><div class="att-chip-avatar" style="background:#e67e2222;color:#e67e22">${initials(u.first_name,u.last_name||'')}</div><span>${u.first_name} <em style="font-size:10px;color:var(--text-faint)">${ci?ci.call_in_type:''}</em></span></div>`;
        }).join('')||'<span class="att-none">None</span>'}</div>
      </div>
      <div class="att-col att-col-pto">
        <div class="att-col-header"><span class="att-dot" style="background:#3498db"></span>Scheduled Off <span class="att-count">${timeoffGroup.length}</span></div>
        <div class="att-chips">${timeoffGroup.map(u=>makeChip(u,'#3498db')).join('')||'<span class="att-none">None</span>'}</div>
      </div>
      <div class="att-col att-col-unknown">
        <div class="att-col-header"><span class="att-dot" style="background:#888"></span>Not Checked In <span class="att-count">${unknownGroup.length}</span></div>
        <div class="att-chips">${unknownGroup.map(u=>makeChip(u,'#888')).join('')||'<span class="att-none">All accounted for ✓</span>'}</div>
      </div>`;
  } catch(e) {
    gridEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Could not load attendance data.</div>';
    console.error(e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PROJECT MANAGEMENT ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let currentProjectId = null;
let currentProjectData = null;
let projectTabActive = 'overview';

const PROJECT_STATUSES = ['awarded','shop_drawings','scheduled','in_progress','punch_list','complete'];
const PROJECT_STATUS_LABELS = {
  awarded:'Awarded', shop_drawings:'Shop Drawings', scheduled:'Scheduled',
  in_progress:'In Progress', punch_list:'Punch List', complete:'Complete'
};
const PROJECT_STATUS_COLORS = {
  awarded:'#7a5010', shop_drawings:'#8e44ad', scheduled:'#2980b9',
  in_progress:'#e67e22', punch_list:'#e74c3c', complete:'#27ae60'
};
const PHASE_STATUSES = ['pending','in_progress','complete'];
const PHASE_STATUS_LABELS = { pending:'Pending', in_progress:'In Progress', complete:'Complete' };

function projectStatusBadge(status) {
  const color = PROJECT_STATUS_COLORS[status] || '#888';
  const label = PROJECT_STATUS_LABELS[status] || status;
  return `<span style="display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;background:${color}22;color:${color};border:1px solid ${color}44">${label}</span>`;
}

// ─── PROJECT LIST ─────────────────────────────────────────────────────────────
async function loadProjects() {
  const statusFilter = $('projStatusFilter') ? $('projStatusFilter').value : '';
  const search = $('projSearch') ? $('projSearch').value.trim() : '';
  const el = $('projectsList');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    let url = '/api/projects?';
    if (statusFilter) url += 'status=' + encodeURIComponent(statusFilter) + '&';
    if (search) url += 'search=' + encodeURIComponent(search) + '&';
    const projects = await api('GET', url.replace(/[?&]$/,''));
    if (!projects.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏗️</div>No projects found. Create your first project to get started.</div>';
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr>
        <th>Job #</th><th>Project</th><th>Customer / Location</th><th>Status</th>
        <th>Scope</th><th>Value</th><th>Start Date</th><th>Hours</th><th></th>
      </tr></thead>
      <tbody>${projects.map(p => `<tr style="cursor:pointer" onclick="openProjectDetail(${p.id})">
        <td style="font-family:monospace;font-size:12px;color:var(--amber)">${p.job_number||'—'}</td>
        <td>
          <div style="font-weight:600;color:var(--white)">${p.project_name}</div>
          ${p.foreman_name ? `<div style="font-size:11px;color:var(--text-faint)">Foreman: ${p.foreman_name}</div>` : ''}
        </td>
        <td>
          <div style="font-size:13px">${p.customer_name||'—'}</div>
          ${p.location ? `<div style="font-size:11px;color:var(--text-muted)">${p.location}</div>` : ''}
        </td>
        <td>${projectStatusBadge(p.status)}</td>
        <td style="font-size:12px;color:var(--text-muted);max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.scope_brief||'—'}</td>
        <td style="font-size:13px;color:var(--amber);font-weight:600">${p.contract_value ? '$'+p.contract_value : '—'}</td>
        <td style="font-size:12px;color:var(--text-muted)">${p.start_date ? fmtDate(p.start_date) : '—'}</td>
        <td style="font-size:12px;color:var(--text-muted)">${parseFloat(p.total_hours||0).toFixed(1)}h</td>
        <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openProjectDetail(${p.id})">View ›</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div style="font-size:12px;color:var(--text-faint);padding:.5rem 0">${projects.length} project${projects.length!==1?'s':''}</div>`;
  } catch(e) { el.innerHTML = '<div class="empty-state">Error loading projects.</div>'; console.error(e); }
}

// ─── PROJECT DETAIL ───────────────────────────────────────────────────────────
async function openProjectDetail(id) {
  currentProjectId = id;
  projectTabActive = 'overview';
  showPage('projectDetail', null);
}

async function loadProjectDetail() {
  if (!currentProjectId) return;
  try {
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    const p = currentProjectData;

    // Header
    if ($('projDetailName')) $('projDetailName').textContent = p.project_name;
    if ($('projDetailStatus')) $('projDetailStatus').innerHTML = projectStatusBadge(p.status);
    if ($('projDetailJob')) $('projDetailJob').textContent = p.job_number || '—';
    if ($('projDetailCustomer')) $('projDetailCustomer').textContent = p.customer_name || '—';
    if ($('projDetailHours')) $('projDetailHours').textContent = parseFloat(p.total_hours||0).toFixed(1) + 'h logged';
    if ($('projDetailValue')) $('projDetailValue').textContent = p.contract_value ? '$' + p.contract_value : '—';

    renderProjectTab();
  } catch(e) { console.error(e); showToast('Error loading project', 'error'); }
}

function setProjectTab(tab, el) {
  projectTabActive = tab;
  document.querySelectorAll('#projTabBar .tab-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderProjectTab();
}

async function renderProjectTab() {
  const p = currentProjectData;
  if (!p) return;
  const el = $('projDetailContent');
  if (!el) return;

  if (projectTabActive === 'overview') {
    const billingLabel = p.billing_type === 'new_construction' ? '🏗️ New Construction (Monthly Billing)' : p.billing_type === 'aftermarket_monthly' ? '🔧 Aftermarket (Monthly Billing)' : '🔧 Aftermarket (Billed on Completion)';
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div class="card">
          <div class="card-header"><span class="card-title">Project Info</span>
            <button class="btn btn-ghost btn-sm" onclick="openEditProject()">Edit</button>
          </div>
          <div class="info-grid">
            <div class="info-row"><span class="info-label">Job Number</span><span class="info-val" style="font-family:monospace;color:var(--amber)">${p.job_number||'—'}</span></div>
            <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${p.customer_name||'—'}</span></div>
            <div class="info-row"><span class="info-label">Location</span><span class="info-val">${p.location||'—'}</span></div>
            <div class="info-row"><span class="info-label">Status</span><span class="info-val">${projectStatusBadge(p.status)}</span></div>
            <div class="info-row"><span class="info-label">Billing</span><span class="info-val" style="font-size:12px">${billingLabel}</span></div>
            <div class="info-row"><span class="info-label">Contract Value</span><span class="info-val" style="color:var(--amber);font-weight:700">${p.contract_value ? '$'+p.contract_value : '—'}</span></div>
            ${p.quote_number ? `<div class="info-row"><span class="info-label">Quote #</span><span class="info-val" style="font-family:monospace">${p.quote_number}</span></div>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Schedule &amp; Team</span></div>
          <div class="info-grid">
            <div class="info-row"><span class="info-label">Start Date</span><span class="info-val">${p.start_date ? fmtDate(p.start_date) : '—'}</span></div>
            <div class="info-row"><span class="info-label">Target End</span><span class="info-val">${p.target_end_date ? fmtDate(p.target_end_date) : '—'}</span></div>
            ${p.actual_end_date ? `<div class="info-row"><span class="info-label">Completed</span><span class="info-val" style="color:#27ae60">${fmtDate(p.actual_end_date)}</span></div>` : ''}
            <div class="info-row"><span class="info-label">Foreman</span><span class="info-val">${p.foreman_name||'—'}</span></div>
            <div class="info-row"><span class="info-label">Total Hours</span><span class="info-val" style="color:var(--amber);font-weight:700">${parseFloat(p.total_hours||0).toFixed(1)}h</span></div>
            <div class="info-row"><span class="info-label">Phases</span><span class="info-val">${(p.phases||[]).length}</span></div>
          </div>
        </div>
        ${p.scope_brief ? `<div class="card" style="grid-column:1/-1">
          <div class="card-header"><span class="card-title">Scope of Work</span></div>
          <div style="font-size:13px;white-space:pre-line;color:var(--text-muted)">${p.scope_brief}</div>
        </div>` : ''}
        ${(p.assigned_techs||[]).length ? `<div class="card" style="grid-column:1/-1">
          <div class="card-header"><span class="card-title">Assigned Technicians</span></div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${(p.assigned_techs||[]).map(t => {
              const u = allUsers.find(u => u.id === t.id) || t;
              const ac = u.avatar_color || avatarBg((u.first_name||'')+(u.last_name||''));
              return `<div style="display:flex;align-items:center;gap:6px;background:${ac}18;border:1px solid ${ac}44;border-radius:20px;padding:5px 10px">
                <div style="width:22px;height:22px;border-radius:50%;background:${ac};color:#000;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${initials(u.first_name||'',u.last_name||'')}</div>
                <span style="font-size:12px;font-weight:600">${u.first_name||''} ${u.last_name||''}</span>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}
        ${p.notes ? `<div class="card" style="grid-column:1/-1">
          <div class="card-header"><span class="card-title">Internal Notes</span></div>
          <div style="font-size:13px;white-space:pre-line;color:var(--text-muted)">${p.notes}</div>
        </div>` : ''}
      </div>`;

  } else if (projectTabActive === 'phases') {
    const phases = p.phases || [];
    el.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
        <button class="btn btn-primary" onclick="openAddPhase()">+ Add Phase</button>
      </div>
      ${phases.length ? phases.map((ph,i) => {
        const phColor = ph.status==='complete' ? '#27ae60' : ph.status==='in_progress' ? '#e67e22' : '#888';
        const phLabel = PHASE_STATUS_LABELS[ph.status] || ph.status;
        return `<div class="card" style="margin-bottom:.75rem;border-left:3px solid ${phColor}">
          <div class="card-header">
            <div>
              <div style="font-family:Oswald,sans-serif;font-size:15px;font-weight:600;color:var(--white)">Phase ${i+1}: ${ph.phase_name}</div>
              ${ph.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${ph.description}</div>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;background:${phColor}22;color:${phColor}">${phLabel}</span>
              <button class="btn btn-ghost btn-sm" onclick="openEditPhase(${ph.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deletePhase(${ph.id})">✕</button>
            </div>
          </div>
          <div style="display:flex;gap:1.5rem;font-size:12px;color:var(--text-muted);margin-top:.25rem">
            ${ph.start_date ? `<span>Start: ${fmtDate(ph.start_date)}</span>` : ''}
            ${ph.end_date ? `<span>End: ${fmtDate(ph.end_date)}</span>` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="empty-state">No phases added yet. Add phases to break the project into stages.</div>'}`;

  } else if (projectTabActive === 'hours') {
    const hours = p.hours || [];
    const totalHrs = hours.reduce((s,h) => s+(h.hours||0), 0);
    // Group by tech
    const byTech = {};
    hours.forEach(h => {
      if (!byTech[h.user_id]) byTech[h.user_id] = {name:h.user_name, hrs:0};
      byTech[h.user_id].hrs += h.hours||0;
    });
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
        <div style="display:flex;gap:1rem">
          <div style="background:var(--amber-bg2);border:1px solid var(--amber-dim);border-radius:var(--radius);padding:8px 16px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:var(--amber)">${totalHrs.toFixed(1)}</div>
            <div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em">Total Hours</div>
          </div>
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:8px 16px;text-align:center">
            <div style="font-size:20px;font-weight:700;color:var(--white)">${Object.keys(byTech).length}</div>
            <div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em">Technicians</div>
          </div>
        </div>
        <button class="btn btn-primary" onclick="openAddHours()">+ Log Hours</button>
      </div>
      ${Object.keys(byTech).length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:1rem">
        ${Object.values(byTech).map(t => `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px">
          <strong>${t.name}</strong> <span style="color:var(--amber)">${t.hrs.toFixed(1)}h</span>
        </div>`).join('')}
      </div>` : ''}
      ${hours.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Technician</th><th>Hours</th><th>Phase</th><th>Type</th><th>Notes</th><th>Logged By</th><th></th></tr></thead>
        <tbody>${hours.map(h => {
          const phase = (p.phases||[]).find(ph => ph.id === h.phase_id);
          return `<tr>
            <td style="font-size:13px">${fmtDate(h.work_date)}</td>
            <td><strong>${h.user_name}</strong></td>
            <td style="color:var(--amber);font-weight:700">${parseFloat(h.hours).toFixed(1)}h</td>
            <td style="font-size:12px;color:var(--text-muted)">${phase ? phase.phase_name : '—'}</td>
            <td><span class="badge ${h.entry_type==='timeclock'?'badge-blue':'badge-gray'}" style="font-size:10px">${h.entry_type==='timeclock'?'⏱ Auto':'✏ Manual'}</span></td>
            <td style="font-size:12px;color:var(--text-muted)">${h.notes||'—'}</td>
            <td style="font-size:11px;color:var(--text-faint)">${h.logged_by||'—'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteProjectHours(${h.id})">✕</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="empty-state">No hours logged yet.</div>'}`;

  } else if (projectTabActive === 'costs') {
    await renderCostTab();
    return;
  } else if (projectTabActive === 'log') {
    const notes = p.notes || [];
    el.innerHTML = `
      <div class="card" style="margin-bottom:1rem">
        <div class="card-header"><span class="card-title">Add Note</span></div>
        <textarea id="projNewNote" rows="3" style="width:100%;background:#0a0a0a;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:10px;font-size:13px;resize:vertical;outline:none;font-family:inherit;box-sizing:border-box" placeholder="Add a project note, update, or log entry..."></textarea>
        <div style="margin-top:.5rem;display:flex;justify-content:flex-end">
          <button class="btn btn-primary" onclick="saveProjectNote()">Post Note</button>
        </div>
      </div>
      ${notes.length ? notes.map(n => `
        <div class="card" style="margin-bottom:.5rem">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-size:12px;font-weight:700;color:var(--amber)">${n.author_name}</div>
              <div style="font-size:11px;color:var(--text-faint)">${n.created_at ? new Date(n.created_at).toLocaleString() : ''}</div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="deleteProjectNote(${n.id})">✕</button>
          </div>
          <div style="margin-top:.5rem;font-size:13px;white-space:pre-line;color:var(--text-muted)">${n.note}</div>
        </div>`).join('') : '<div class="empty-state">No notes yet. Use this log to track progress, issues, and updates.</div>'}`;
  }
}

// ─── PROJECT CRUD ─────────────────────────────────────────────────────────────
async function openAddProject() {
  if (!allUsers.length) try { allUsers = await api('GET', '/api/users'); } catch(e){}
  let customers = [];
  try { customers = await api('GET', '/api/customers'); } catch(e){}
  let quotes = [];
  try { quotes = await api('GET', '/api/quotes'); } catch(e){}

  $('projModalId').value = '';
  $('projModalTitle').textContent = 'New Project';
  ['projModalJobNum','projModalName','projModalLocation','projModalValue',
   'projModalScopeBrief','projModalNotes','projModalStartDate','projModalEndDate'].forEach(id => { const el=$(id); if(el) el.value=''; });
  if ($('projModalStatus')) $('projModalStatus').value = 'awarded';
  if ($('projModalBilling')) $('projModalBilling').value = 'aftermarket';

  const custSel = $('projModalCustomer');
  if (custSel) custSel.innerHTML = '<option value="">— Select Customer —</option>' + customers.map(c=>`<option value="${c.id}" data-name="${c.company_name}">${c.company_name}</option>`).join('');

  const quoteSel = $('projModalQuote');
  if (quoteSel) quoteSel.innerHTML = '<option value="">— No Quote —</option>' + quotes.map(q=>`<option value="${q.id}" data-num="${q.quote_number||''}" data-val="${q.total||''}">${q.quote_number||'Q-'+q.id} — ${q.client_name} — ${q.project_name||'Unnamed'}</option>`).join('');

  const foremanSel = $('projModalForeman');
  if (foremanSel) foremanSel.innerHTML = '<option value="">— No Foreman —</option>' + allUsers.map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join('');

  renderTechCheckboxes([]);
  // Phase 1A: work types, required skills, revenue department
  await renderWorkTypesCheckboxes([]);
  await renderSkillsCheckboxes('proj', []);
  if ($('projModalRevenueDept')) {
    // Prefill from current user's sales dept
    try {
      const me = currentUser || {};
      const ext = me.id ? await api('GET','/api/users/'+me.id+'/extended').catch(()=>null) : null;
      $('projModalRevenueDept').value = (ext && ext.sales_department) || '';
    } catch(e) { $('projModalRevenueDept').value = ''; }
  }
  const projCheckAll = $('projSkillsCheckAll');
  if (projCheckAll) projCheckAll.checked = false;
  openModal('projectModal');
}

async function openEditProject() {
  const p = currentProjectData;
  if (!p) return;
  if (!allUsers.length) try { allUsers = await api('GET', '/api/users'); } catch(e){}
  let customers = [];
  try { customers = await api('GET', '/api/customers'); } catch(e){}
  let quotes = [];
  try { quotes = await api('GET', '/api/quotes'); } catch(e){}

  $('projModalId').value = p.id;
  $('projModalTitle').textContent = 'Edit Project';
  $('projModalJobNum').value = p.job_number || '';
  $('projModalName').value = p.project_name || '';
  $('projModalLocation').value = p.location || '';
  $('projModalValue').value = p.contract_value || '';
  $('projModalScopeBrief').value = p.scope_brief || '';
  $('projModalNotes').value = p.notes || '';
  $('projModalStartDate').value = p.start_date || '';
  $('projModalEndDate').value = p.target_end_date || '';
  if ($('projModalStatus')) $('projModalStatus').value = p.status || 'awarded';
  if ($('projModalBilling')) $('projModalBilling').value = p.billing_type || 'aftermarket';

  const custSel = $('projModalCustomer');
  if (custSel) { custSel.innerHTML = '<option value="">— Select Customer —</option>' + customers.map(c=>`<option value="${c.id}">${c.company_name}</option>`).join(''); custSel.value = p.customer_id || ''; }

  const quoteSel = $('projModalQuote');
  if (quoteSel) { quoteSel.innerHTML = '<option value="">— No Quote —</option>' + quotes.map(q=>`<option value="${q.id}" data-num="${q.quote_number||''}" data-val="${q.total||''}">${q.quote_number||'Q-'+q.id} — ${q.client_name} — ${q.project_name||'Unnamed'}</option>`).join(''); quoteSel.value = p.quote_id || ''; }

  const foremanSel = $('projModalForeman');
  if (foremanSel) { foremanSel.innerHTML = '<option value="">— No Foreman —</option>' + allUsers.map(u=>`<option value="${u.id}">${displayName(u)}</option>`).join(''); foremanSel.value = p.foreman_id || ''; }

  renderTechCheckboxes(p.assigned_techs || []);
  // Phase 1A: classification
  await renderWorkTypesCheckboxes(p.work_types || []);
  await renderSkillsCheckboxes('proj', p.required_skills || []);
  if ($('projModalRevenueDept')) $('projModalRevenueDept').value = p.revenue_department || '';
  const projCheckAll = $('projSkillsCheckAll');
  if (projCheckAll) projCheckAll.checked = false;
  openModal('projectModal');
}

function renderTechCheckboxes(selected) {
  const el = $('projTechCheckboxes');
  if (!el) return;
  const selectedIds = new Set((selected||[]).map(t => t.id || t));
  const techs = allUsers.filter(u => !['global_admin','admin'].includes(u.role_type||''));
  el.innerHTML = techs.map(u => {
    const ac = u.avatar_color || avatarBg(u.first_name+(u.last_name||''));
    return `<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;border:1px solid ${selectedIds.has(u.id)?'var(--amber)':'var(--border)'};background:${selectedIds.has(u.id)?'var(--amber-bg2)':'transparent'};margin-bottom:4px">
      <input type="checkbox" value="${u.id}" ${selectedIds.has(u.id)?'checked':''} onchange="this.closest('label').style.borderColor=this.checked?'var(--amber)':'var(--border)';this.closest('label').style.background=this.checked?'var(--amber-bg2)':'transparent'" />
      <div style="width:22px;height:22px;border-radius:50%;background:${ac};color:#000;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">${initials(u.first_name,u.last_name||'')}</div>
      <span style="font-size:13px">${displayName(u)}</span>
    </label>`;
  }).join('');
}

function getSelectedTechs() {
  const el = $('projTechCheckboxes');
  if (!el) return [];
  return Array.from(el.querySelectorAll('input[type=checkbox]:checked')).map(cb => {
    const u = allUsers.find(u => u.id === parseInt(cb.value));
    return u ? {id:u.id, first_name:u.first_name, last_name:u.last_name||''} : {id:parseInt(cb.value)};
  });
}

function onProjQuoteChange() {
  const sel = $('projModalQuote');
  if (!sel || !sel.value) return;
  const opt = sel.options[sel.selectedIndex];
  const val = opt.getAttribute('data-val');
  if (val && $('projModalValue') && !$('projModalValue').value) $('projModalValue').value = val.replace(/[^0-9.]/g,'');
}

async function saveProject() {
  const id = $('projModalId').value;
  const custSel = $('projModalCustomer');
  const custOpt = custSel && custSel.value ? custSel.options[custSel.selectedIndex] : null;
  const quoteSel = $('projModalQuote');
  const quoteOpt = quoteSel && quoteSel.value ? quoteSel.options[quoteSel.selectedIndex] : null;
  const foremanSel = $('projModalForeman');
  const foremanOpt = foremanSel && foremanSel.value ? foremanSel.options[foremanSel.selectedIndex] : null;

  const payload = {
    job_number: $('projModalJobNum').value.trim(),
    project_name: $('projModalName').value.trim(),
    customer_id: custSel ? parseInt(custSel.value)||0 : 0,
    customer_name: custOpt ? custOpt.textContent.trim() : '',
    location: $('projModalLocation').value.trim(),
    quote_id: quoteSel ? parseInt(quoteSel.value)||0 : 0,
    quote_number: quoteOpt ? (quoteOpt.getAttribute('data-num')||'') : '',
    contract_value: $('projModalValue').value.trim(),
    billing_type: $('projModalBilling') ? $('projModalBilling').value : 'aftermarket',
    scope_brief: $('projModalScopeBrief').value.trim(),
    status: $('projModalStatus') ? $('projModalStatus').value : 'awarded',
    start_date: $('projModalStartDate').value,
    target_end_date: $('projModalEndDate').value,
    foreman_id: foremanSel ? parseInt(foremanSel.value)||0 : 0,
    foreman_name: foremanOpt ? foremanOpt.textContent.trim() : '',
    assigned_techs: getSelectedTechs(),
    notes: $('projModalNotes').value.trim()
  };
  if (!payload.project_name) return showToast('Project name is required.', 'error');
  try {
    let savedId;
    if (id) {
      await api('PUT', '/api/projects/' + id, payload);
      savedId = id;
      showToast('Project updated!', 'success');
    } else {
      const r = await api('POST', '/api/projects', payload);
      savedId = r.id;
      showToast('Project created!', 'success');
    }
    // Phase 1A: save work-meta (work types, required skills, revenue department)
    try {
      const workTypes = collectCheckedWorkTypes();
      const requiredSkills = collectCheckedSkills('proj');
      const revenueDept = $('projModalRevenueDept') ? $('projModalRevenueDept').value : '';
      await api('PUT', '/api/projects/' + savedId + '/work-meta', {
        work_types: workTypes,
        required_skills: requiredSkills,
        revenue_department: revenueDept
      });
    } catch(e) { /* silent — non-critical */ }
    closeModal('projectModal');
    if (id) {
      await loadProjectDetail();
    } else {
      openProjectDetail(savedId);
      loadProjects();
    }
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteProject() {
  if (!currentProjectId) return;
  if (!confirm('Delete this project? All phases, hours, and notes will be permanently removed.')) return;
  try {
    await api('DELETE', '/api/projects/' + currentProjectId);
    showToast('Project deleted.', 'success');
    currentProjectId = null; currentProjectData = null;
    showPage('projects', null);
    loadProjects();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── PHASE CRUD ───────────────────────────────────────────────────────────────
function openAddPhase() {
  $('phaseModalId').value = '';
  $('phaseModalTitle').textContent = 'Add Phase';
  ['phaseModalName','phaseModalDesc','phaseModalStart','phaseModalEnd'].forEach(id => { const el=$(id); if(el) el.value=''; });
  if ($('phaseModalStatus')) $('phaseModalStatus').value = 'pending';
  openModal('phaseModal');
}

function openEditPhase(phaseId) {
  const ph = (currentProjectData.phases||[]).find(p => p.id === phaseId);
  if (!ph) return;
  $('phaseModalId').value = ph.id;
  $('phaseModalTitle').textContent = 'Edit Phase';
  $('phaseModalName').value = ph.phase_name || '';
  $('phaseModalDesc').value = ph.description || '';
  $('phaseModalStart').value = ph.start_date || '';
  $('phaseModalEnd').value = ph.end_date || '';
  if ($('phaseModalStatus')) $('phaseModalStatus').value = ph.status || 'pending';
  openModal('phaseModal');
}

async function savePhase() {
  const id = $('phaseModalId').value;
  const payload = {
    phase_name: $('phaseModalName').value.trim(),
    description: $('phaseModalDesc').value.trim(),
    status: $('phaseModalStatus') ? $('phaseModalStatus').value : 'pending',
    start_date: $('phaseModalStart').value,
    end_date: $('phaseModalEnd').value,
    sort_order: id ? ((currentProjectData.phases||[]).find(p=>p.id===parseInt(id))||{}).sort_order||0 : (currentProjectData.phases||[]).length
  };
  if (!payload.phase_name) return showToast('Phase name is required.', 'error');
  try {
    if (id) await api('PUT', '/api/projects/' + currentProjectId + '/phases/' + id, payload);
    else await api('POST', '/api/projects/' + currentProjectId + '/phases', payload);
    showToast('Phase saved!', 'success');
    closeModal('phaseModal');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderProjectTab();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deletePhase(phaseId) {
  if (!confirm('Delete this phase?')) return;
  try {
    await api('DELETE', '/api/projects/' + currentProjectId + '/phases/' + phaseId);
    showToast('Phase deleted.', 'success');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderProjectTab();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── HOURS CRUD ───────────────────────────────────────────────────────────────
async function openAddHours() {
  if (!allUsers.length) try { allUsers = await api('GET', '/api/users'); } catch(e){}
  const p = currentProjectData;
  const today = new Date().toISOString().split('T')[0];
  $('hoursModalDate').value = today;
  $('hoursModalHours').value = '8';
  $('hoursModalNotes').value = '';

  const techSel = $('hoursModalTech');
  if (techSel) techSel.innerHTML = '<option value="">— Select Tech —</option>' +
    allUsers.filter(u=>!['global_admin','admin'].includes(u.role_type||'')).map(u=>`<option value="${u.id}" data-name="${displayName(u)}">${displayName(u)}</option>`).join('');

  const phaseSel = $('hoursModalPhase');
  if (phaseSel) phaseSel.innerHTML = '<option value="">— No Phase —</option>' +
    (p.phases||[]).map(ph=>`<option value="${ph.id}">${ph.phase_name}</option>`).join('');

  openModal('hoursModal');
}

async function saveProjectHours() {
  const techSel = $('hoursModalTech');
  const techOpt = techSel && techSel.value ? techSel.options[techSel.selectedIndex] : null;
  const payload = {
    user_id: techSel ? parseInt(techSel.value)||0 : 0,
    user_name: techOpt ? techOpt.getAttribute('data-name') || techOpt.textContent.trim() : '',
    work_date: $('hoursModalDate').value,
    hours: parseFloat($('hoursModalHours').value)||0,
    phase_id: $('hoursModalPhase') ? parseInt($('hoursModalPhase').value)||0 : 0,
    entry_type: 'manual',
    notes: $('hoursModalNotes').value.trim()
  };
  if (!payload.user_id) return showToast('Select a technician.', 'error');
  if (!payload.work_date) return showToast('Select a date.', 'error');
  if (!payload.hours || payload.hours <= 0) return showToast('Enter valid hours.', 'error');
  try {
    await api('POST', '/api/projects/' + currentProjectId + '/hours', payload);
    showToast('Hours logged!', 'success');
    closeModal('hoursModal');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    if ($('projDetailHours')) $('projDetailHours').textContent = parseFloat(currentProjectData.total_hours||0).toFixed(1) + 'h logged';
    renderProjectTab();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteProjectHours(hid) {
  if (!confirm('Remove this hours entry?')) return;
  try {
    await api('DELETE', '/api/projects/' + currentProjectId + '/hours/' + hid);
    showToast('Entry removed.', 'success');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    if ($('projDetailHours')) $('projDetailHours').textContent = parseFloat(currentProjectData.total_hours||0).toFixed(1) + 'h logged';
    renderProjectTab();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── NOTES CRUD ───────────────────────────────────────────────────────────────
async function saveProjectNote() {
  const note = $('projNewNote') ? $('projNewNote').value.trim() : '';
  if (!note) return showToast('Enter a note.', 'error');
  try {
    await api('POST', '/api/projects/' + currentProjectId + '/notes', { note });
    showToast('Note added!', 'success');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderProjectTab();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteProjectNote(nid) {
  if (!confirm('Delete this note?')) return;
  try {
    await api('DELETE', '/api/projects/' + currentProjectId + '/notes/' + nid);
    showToast('Note deleted.', 'success');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderProjectTab();
  } catch(e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── JOB COSTING ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const COST_CATEGORIES = ['materials','equipment','labor','subcontractors'];
const COST_CAT_LABELS = { materials:'Materials', equipment:'Equipment', labor:'Labor', subcontractors:'Subcontractors' };
const COST_CAT_COLORS = { materials:'#2980b9', equipment:'#8e44ad', labor:'#e67e22', subcontractors:'#16a085' };
const COST_CAT_ICONS  = { materials:'📦', equipment:'🔧', labor:'👷', subcontractors:'🤝' };

function fmtMoney(val) {
  const n = parseFloat(val)||0;
  return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

// ─── COST TAB RENDERER ────────────────────────────────────────────────────────
async function renderCostTab() {
  const p = currentProjectData;
  const el = $('projDetailContent');
  if (!el || !p) return;

  const costs = p.costs || [];
  const hours = p.hours || [];

  // Build actuals per category
  const actuals = { materials:0, equipment:0, labor:0, subcontractors:0 };
  costs.forEach(c => { if (actuals[c.category] !== undefined) actuals[c.category] += parseFloat(c.total_cost)||0; });
  // Labor from hours — use a rate if available, else just show hours
  const totalLaborHours = hours.reduce((s,h) => s+(h.hours||0), 0);
  // Budget
  const budgets = {
    materials: parseFloat(p.budget_materials)||0,
    equipment: parseFloat(p.budget_equipment)||0,
    labor:     parseFloat(p.budget_labor)||0,
    subcontractors: parseFloat(p.budget_subs)||0
  };
  const contractVal = parseFloat((p.contract_value||'').replace(/[^0-9.]/g,''))||0;
  const totalActual = Object.values(actuals).reduce((s,v)=>s+v,0);
  const totalBudget = Object.values(budgets).reduce((s,v)=>s+v,0);
  const margin = contractVal - totalActual;
  const marginPct = contractVal ? ((margin/contractVal)*100).toFixed(1) : null;

  function budgetBar(cat) {
    const b = budgets[cat], a = actuals[cat];
    const pct = b ? Math.min((a/b)*100,100) : (a>0?100:0);
    const color = pct>=90 ? '#e74c3c' : pct>=70 ? '#e67e22' : '#27ae60';
    return `
      <div style="margin-bottom:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600">${COST_CAT_ICONS[cat]} ${COST_CAT_LABELS[cat]}</span>
          <span style="font-size:12px;color:var(--text-muted)">${fmtMoney(a)} <span style="color:var(--text-faint)">/ ${b ? fmtMoney(b) : 'no budget'}</span></span>
        </div>
        <div style="height:8px;background:#222;border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width .3s"></div>
        </div>
        <div style="font-size:10px;color:${pct>=90?'#e74c3c':pct>=70?'#e67e22':'var(--text-faint)'};margin-top:2px">${pct.toFixed(0)}% used${b&&a>b?` — <strong style="color:#e74c3c">OVER by ${fmtMoney(a-b)}</strong>`:''}${cat==='labor'&&totalLaborHours?` · ${totalLaborHours.toFixed(1)}h logged`:''}
        </div>
      </div>`;
  }

  el.innerHTML = `
    <!-- Summary Cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.75rem;margin-bottom:1.25rem">
      ${contractVal ? `<div class="card" style="text-align:center">
        <div style="font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Contract Value</div>
        <div style="font-size:22px;font-weight:700;color:var(--amber)">${fmtMoney(contractVal)}</div>
      </div>` : ''}
      <div class="card" style="text-align:center">
        <div style="font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Total Cost</div>
        <div style="font-size:22px;font-weight:700;color:var(--white)">${fmtMoney(totalActual)}</div>
      </div>
      ${contractVal ? `<div class="card" style="text-align:center">
        <div style="font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Margin</div>
        <div style="font-size:22px;font-weight:700;color:${margin>=0?'#27ae60':'#e74c3c'}">${fmtMoney(margin)}</div>
        ${marginPct ? `<div style="font-size:11px;color:var(--text-faint)">${marginPct}%</div>` : ''}
      </div>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem">
      <!-- Budget vs Actual -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Budget vs Actual</span>
          <button class="btn btn-ghost btn-sm" onclick="openEditBudgets()">Edit Budgets</button>
        </div>
        ${COST_CATEGORIES.map(cat => budgetBar(cat)).join('')}
      </div>

      <!-- Category Breakdown -->
      <div class="card">
        <div class="card-header"><span class="card-title">Cost Breakdown</span></div>
        ${COST_CATEGORIES.map(cat => {
          const a = actuals[cat];
          const pct = totalActual ? ((a/totalActual)*100).toFixed(1) : 0;
          const color = COST_CAT_COLORS[cat];
          return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
            <div style="flex:1;font-size:13px">${COST_CAT_ICONS[cat]} ${COST_CAT_LABELS[cat]}</div>
            <div style="font-size:13px;font-weight:600">${fmtMoney(a)}</div>
            <div style="font-size:11px;color:var(--text-faint);width:36px;text-align:right">${pct}%</div>
          </div>`;
        }).join('')}
        <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;font-weight:700">
          <span>Total</span><span style="color:var(--amber)">${fmtMoney(totalActual)}</span>
        </div>
      </div>
    </div>

    <!-- Cost Line Items -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Cost Entries</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="openAiInvoice()">📄 AI Invoice Upload</button>
          <button class="btn btn-primary btn-sm" onclick="openAddCost()">+ Add Cost</button>
        </div>
      </div>
      ${costs.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>PO #</th><th>Category</th><th>Vendor</th><th>Description</th><th>Qty</th><th>Unit Cost</th><th>Total</th><th>Invoice #</th><th>Date</th><th></th></tr></thead>
        <tbody>${costs.map(c => `<tr>
          <td style="font-family:monospace;font-size:12px;color:var(--amber);white-space:nowrap">${c.po_number||'—'}</td>
          <td><span style="font-size:11px;font-weight:700;color:${COST_CAT_COLORS[c.category]||'#888'}">${COST_CAT_ICONS[c.category]||''} ${COST_CAT_LABELS[c.category]||c.category}</span></td>
          <td style="font-size:12px">${c.vendor||'—'}</td>
          <td style="font-size:13px;font-weight:500">${c.description}</td>
          <td style="font-size:12px;color:var(--text-muted)">${parseFloat(c.quantity)===1?'—':c.quantity}</td>
          <td style="font-size:12px;color:var(--text-muted)">${parseFloat(c.unit_cost)>0?fmtMoney(c.unit_cost):'—'}</td>
          <td style="font-weight:700;color:var(--white)">${fmtMoney(c.total_cost)}</td>
          <td style="font-size:12px;color:var(--text-muted)">${c.invoice_number||'—'}</td>
          <td style="font-size:12px;color:var(--text-muted)">${c.invoice_date?fmtDate(c.invoice_date):'—'}</td>
          <td style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm" onclick="openEditCost(${c.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCost(${c.id})">✕</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty-state">No cost entries yet. Add costs manually or use AI invoice upload.</div>'}
    </div>`;
}

// ─── BUDGET EDIT ──────────────────────────────────────────────────────────────
function openEditBudgets() {
  const p = currentProjectData;
  $('budgetMaterials').value = p.budget_materials || '';
  $('budgetEquipment').value = p.budget_equipment || '';
  $('budgetLabor').value = p.budget_labor || '';
  $('budgetSubs').value = p.budget_subs || '';
  openModal('budgetModal');
}

async function saveBudgets() {
  const payload = {
    budget_materials: parseFloat($('budgetMaterials').value)||0,
    budget_equipment: parseFloat($('budgetEquipment').value)||0,
    budget_labor:     parseFloat($('budgetLabor').value)||0,
    budget_subs:      parseFloat($('budgetSubs').value)||0
  };
  try {
    await api('PUT', '/api/projects/' + currentProjectId + '/budgets', payload);
    showToast('Budgets saved!', 'success');
    closeModal('budgetModal');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderCostTab();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── COST ENTRY CRUD ─────────────────────────────────────────────────────────
async function openAddCost() {
  $('costModalId').value = '';
  $('costModalTitle').textContent = 'Add Cost Entry';
  $('costVendor').value = '';
  $('costDesc').value = '';
  $('costQty').value = '1';
  $('costUnitCost').value = '';
  $('costTotal').value = '';
  $('costInvNum').value = '';
  $('costInvDate').value = new Date().toISOString().split('T')[0];
  $('costNotes').value = '';
  if ($('costCategory')) $('costCategory').value = 'materials';
  // Show next PO
  try { const r = await api('GET','/api/po/next'); if($('costPoPreview')) $('costPoPreview').textContent = 'Next PO: ' + r.po_number; } catch(e){}
  openModal('costModal');
}

function openEditCost(costId) {
  const c = (currentProjectData.costs||[]).find(x => x.id === costId);
  if (!c) return;
  $('costModalId').value = c.id;
  $('costModalTitle').textContent = 'Edit Cost Entry';
  if ($('costCategory')) $('costCategory').value = c.category || 'materials';
  $('costVendor').value = c.vendor || '';
  $('costDesc').value = c.description || '';
  $('costQty').value = c.quantity || 1;
  $('costUnitCost').value = c.unit_cost || '';
  $('costTotal').value = c.total_cost || '';
  $('costInvNum').value = c.invoice_number || '';
  $('costInvDate').value = c.invoice_date || '';
  $('costNotes').value = c.notes || '';
  if ($('costPoPreview')) $('costPoPreview').textContent = 'PO: ' + (c.po_number||'—');
  openModal('costModal');
}

function calcCostTotal() {
  const qty = parseFloat($('costQty').value)||1;
  const unit = parseFloat($('costUnitCost').value)||0;
  if (unit > 0) $('costTotal').value = (qty * unit).toFixed(2);
}

async function saveCost() {
  const id = $('costModalId').value;
  const payload = {
    category: $('costCategory') ? $('costCategory').value : 'materials',
    vendor: $('costVendor').value.trim(),
    description: $('costDesc').value.trim(),
    quantity: parseFloat($('costQty').value)||1,
    unit_cost: parseFloat($('costUnitCost').value)||0,
    total_cost: parseFloat($('costTotal').value)||0,
    invoice_number: $('costInvNum').value.trim(),
    invoice_date: $('costInvDate').value,
    notes: $('costNotes').value.trim()
  };
  if (!payload.description) return showToast('Description is required.', 'error');
  if (!payload.total_cost) return showToast('Enter a total cost.', 'error');
  try {
    if (id) {
      await api('PUT', '/api/projects/' + currentProjectId + '/costs/' + id, payload);
      showToast('Cost updated!', 'success');
    } else {
      const r = await api('POST', '/api/projects/' + currentProjectId + '/costs', payload);
      showToast('Cost added! PO: ' + r.po_number, 'success');
    }
    closeModal('costModal');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderCostTab();
  } catch(e) { showToast(e.message, 'error'); }
}

async function deleteCost(costId) {
  if (!confirm('Delete this cost entry?')) return;
  try {
    await api('DELETE', '/api/projects/' + currentProjectId + '/costs/' + costId);
    showToast('Cost deleted.', 'success');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderCostTab();
  } catch(e) { showToast(e.message, 'error'); }
}

// ─── AI INVOICE UPLOAD ────────────────────────────────────────────────────────
function openAiInvoice() {
  $('aiInvoiceFile').value = '';
  $('aiInvoiceStatus').textContent = '';
  $('aiInvoiceStatus').className = '';
  $('aiInvoiceLines').innerHTML = '';
  $('aiInvoiceConfirmBtn').style.display = 'none';
  openModal('aiInvoiceModal');
}

async function processAiInvoice() {
  const file = $('aiInvoiceFile').files[0];
  if (!file) return showToast('Select a file first.', 'error');
  const statusEl = $('aiInvoiceStatus');
  const linesEl = $('aiInvoiceLines');
  statusEl.textContent = '🤖 Analyzing invoice...';
  statusEl.className = 'quotes-ai-status thinking';
  linesEl.innerHTML = '';
  $('aiInvoiceConfirmBtn').style.display = 'none';

  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.onerror = () => rej(new Error('Read failed'));
      r.readAsDataURL(file);
    });
    const mediaType = file.type || 'image/jpeg';
    const p = currentProjectData;
    const result = await api('POST', '/api/projects/' + currentProjectId + '/costs/extract', {
      image_data: base64, media_type: mediaType,
      project_name: p.project_name, job_number: p.job_number
    });

    if (!result.lines || !result.lines.length) {
      statusEl.textContent = '⚠ No line items found. Try a clearer image.';
      statusEl.className = 'quotes-ai-status error';
      return;
    }

    statusEl.textContent = `✓ Found ${result.lines.length} line item${result.lines.length!==1?'s':''}. Review and confirm below.`;
    statusEl.className = 'quotes-ai-status done';

    linesEl.innerHTML = `
      <div style="background:#111;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-top:10px">
        <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:8px;font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.05em">
          <span>Vendor: <strong style="color:var(--amber)">${result.vendor||'Unknown'}</strong></span>
          <span>Invoice: <strong>${result.invoice_number||'—'}</strong></span>
          <span>Date: <strong>${result.invoice_date||'—'}</strong></span>
        </div>
        <table class="data-table" style="font-size:12px">
          <thead><tr><th>Category</th><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th><th>✓</th></tr></thead>
          <tbody>${result.lines.map((line,i) => `<tr>
            <td><select id="aiCat_${i}" style="background:#111;border:1px solid var(--border);color:var(--text);padding:3px 6px;font-size:11px;border-radius:4px">
              ${COST_CATEGORIES.map(c=>`<option value="${c}" ${c===line.category?'selected':''}>${COST_CAT_LABELS[c]}</option>`).join('')}
            </select></td>
            <td><input id="aiDesc_${i}" type="text" value="${line.description}" style="background:transparent;border:none;border-bottom:1px dashed var(--border);color:var(--text);width:100%;padding:2px 0;font-size:12px;outline:none" /></td>
            <td style="text-align:center">${parseFloat(line.quantity)||1}</td>
            <td>${line.unit_cost>0?fmtMoney(line.unit_cost):'—'}</td>
            <td style="font-weight:700">${fmtMoney(line.total_cost)}</td>
            <td style="text-align:center"><input type="checkbox" id="aiChk_${i}" checked /></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;

    // Store parsed data for confirmation
    $('aiInvoiceConfirmBtn').style.display = 'inline-flex';
    $('aiInvoiceConfirmBtn')._parsed = result;
    $('aiInvoiceConfirmBtn')._lineCount = result.lines.length;
  } catch(e) {
    statusEl.textContent = '✗ Error: ' + e.message;
    statusEl.className = 'quotes-ai-status error';
  }
}

async function confirmAiInvoice() {
  const btn = $('aiInvoiceConfirmBtn');
  const parsed = btn._parsed;
  const count = btn._lineCount;
  if (!parsed) return;

  const statusEl = $('aiInvoiceStatus');
  statusEl.textContent = 'Saving...';
  statusEl.className = 'quotes-ai-status thinking';

  let saved = 0;
  for (let i = 0; i < count; i++) {
    const chk = $('aiChk_' + i);
    if (!chk || !chk.checked) continue;
    const line = parsed.lines[i];
    const desc = $('aiDesc_' + i) ? $('aiDesc_' + i).value.trim() : line.description;
    const cat  = $('aiCat_' + i) ? $('aiCat_' + i).value : (line.category||'materials');
    try {
      await api('POST', '/api/projects/' + currentProjectId + '/costs', {
        category: cat, vendor: parsed.vendor||'',
        description: desc, quantity: parseFloat(line.quantity)||1,
        unit_cost: parseFloat(line.unit_cost)||0, total_cost: parseFloat(line.total_cost)||0,
        invoice_number: parsed.invoice_number||'', invoice_date: parsed.invoice_date||''
      });
      saved++;
    } catch(e) { console.error('Line save error', e); }
  }

  statusEl.textContent = `✓ ${saved} item${saved!==1?'s':''} saved!`;
  statusEl.className = 'quotes-ai-status done';
  showToast(saved + ' cost entr' + (saved===1?'y':'ies') + ' added!', 'success');
  setTimeout(async () => {
    closeModal('aiInvoiceModal');
    currentProjectData = await api('GET', '/api/projects/' + currentProjectId);
    renderCostTab();
  }, 1200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SALES & QUOTES ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let quotesAllQuotes = [];
let quotesCurrentId = null;
let quotesCurrentScopes = [];
let quotesCurrentOptions = [];
let quotesCurrentFile = null;

function quotesShowList() {
  $('quotes-list-view').style.display = 'block';
  $('quotes-builder-view').style.display = 'none';
  $('salesHeaderBtns').style.display = 'flex';
  $('salesPageSub').textContent = 'Create, manage, and track service quotes';
  quotesCurrentId = null;
  quotesLoadList();
}

function quotesNewQuote() {
  quotesCurrentId = null;
  quotesCurrentScopes = [];
  quotesCurrentOptions = [];
  quotesCurrentFile = null;
  $('quotes-list-view').style.display = 'none';
  $('quotes-builder-view').style.display = 'block';
  $('salesPageSub').textContent = 'New Quote';
  // Reset fields
  const today = new Date().toISOString().split('T')[0];
  ['q-num','q-client','q-contact','q-phone','q-email','q-addr','q-project','q-scope-summary','q-notes','q-subtotal','q-tax','q-total'].forEach(id => { const el=$(id); if(el) el.value=''; });
  if($('q-date')) $('q-date').value = today;
  if($('q-valid')) $('q-valid').value = '30 days';
  if($('q-status')) $('q-status').value = 'draft';
  if($('q-save-status')) $('q-save-status').textContent = '';
  if($('ai-status-msg')) $('ai-status-msg').textContent = 'Paste notes or upload a file, then click Analyze.';
  if($('ai-file-preview-tag')) { $('ai-file-preview-tag').style.display='none'; $('ai-file-preview-tag').textContent=''; }
  // Phase 1A.1 additions
  if($('q-customer-id')) $('q-customer-id').value = '0';
  if($('q-client-linked')) $('q-client-linked').style.display = 'none';
  if($('q-client-newmode')) $('q-client-newmode').checked = false;
  if($('q-client')) $('q-client').placeholder = 'Start typing to search customers...';
  if($('q-rep-display')) $('q-rep-display').textContent = currentUser ? (currentUser.first_name + (currentUser.last_name?' '+currentUser.last_name:'')) : '—';
  if($('q-created-display')) $('q-created-display').textContent = '';
  const cpBtn = $('q-create-project-btn'); if (cpBtn) cpBtn.style.display = 'none';
  $('q-scopes-container').innerHTML = '';
  $('q-options-container').innerHTML = '';
  quotesAddScope();
  // Pre-load customers cache for search
  quotesLoadCustomerCache();
  // Phase 1A.1.1 — prefill next auto job number (peek, not allocate)
  quotesResetNumEditState();
  quotesPrefillNextJobNumber();
}

async function quotesLoadList() {
  const body = $('quotes-table-body');
  const countEl = $('quotes-count');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint);font-size:13px">Loading...</div>';
  try {
    quotesAllQuotes = await api('GET', '/api/quotes');
    quotesRenderList();
  } catch(e) { body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);font-size:13px">Error loading quotes: ' + e.message + '</div>'; }
}

function quotesFilter() { quotesRenderList(); }

function quotesRenderList() {
  const body = $('quotes-table-body');
  const countEl = $('quotes-count');
  const search = ($('quotes-search') && $('quotes-search').value.toLowerCase()) || '';
  const statusF = ($('quotes-status-filter') && $('quotes-status-filter').value) || '';
  let filtered = quotesAllQuotes;
  if (search) filtered = filtered.filter(q => (q.client_name||'').toLowerCase().includes(search) || (q.project_name||'').toLowerCase().includes(search) || (q.quote_number||'').toLowerCase().includes(search) || (q.rep_name||'').toLowerCase().includes(search));
  if (statusF) filtered = filtered.filter(q => q.status === statusF);
  if (countEl) countEl.textContent = filtered.length + ' quote' + (filtered.length !== 1 ? 's' : '');
  if (!filtered.length) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint);font-size:13px">' + (quotesAllQuotes.length ? 'No quotes match your filter.' : 'No quotes yet. Click + New Quote to create your first one.') + '</div>';
    return;
  }
  const statusColors = { draft:'#888', sent:'#2980b9', accepted:'#27ae60', declined:'#e74c3c' };
  body.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Quote #</th><th>Client</th><th>Project</th><th>Rep</th><th>Total</th><th>Status</th><th>Date</th><th></th></tr></thead>
    <tbody>${filtered.map(q => {
      const sc = statusColors[q.status] || '#888';
      return `<tr style="cursor:pointer" onclick="quotesOpenEdit(${q.id})">
        <td style="font-family:monospace;font-size:12px;color:var(--amber)">${q.quote_number||'—'}</td>
        <td><strong>${q.client_name||'—'}</strong></td>
        <td style="font-size:12px;color:var(--text-muted)">${q.project_name||'—'}</td>
        <td style="font-size:12px;color:var(--text-muted)">${q.rep_name||'—'}</td>
        <td style="font-weight:600">${q.total ? '$'+q.total : '—'}</td>
        <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;background:${sc}22;color:${sc};border:1px solid ${sc}44">${q.status||'draft'}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${q.updated_at ? fmtDate(q.updated_at.split(' ')[0]) : '—'}</td>
        <td style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();quotesOpenEdit(${q.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();quotesDelete(${q.id})">✕</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

async function quotesOpenEdit(id) {
  try {
    const q = await api('GET', '/api/quotes/' + id);
    quotesCurrentId = id;
    quotesCurrentScopes = q.scopes || [];
    quotesCurrentOptions = q.options || [];
    $('quotes-list-view').style.display = 'none';
    $('quotes-builder-view').style.display = 'block';
    $('salesPageSub').textContent = 'Edit Quote';
    if($('q-num')) $('q-num').value = q.quote_number || '';
    if($('q-date')) $('q-date').value = q.created_at ? q.created_at.split(' ')[0] : '';
    if($('q-valid')) $('q-valid').value = q.valid_for || '30 days';
    if($('q-status')) $('q-status').value = q.status || 'draft';
    if($('q-client')) $('q-client').value = q.client_name || '';
    if($('q-contact')) $('q-contact').value = q.contact_name || '';
    if($('q-phone')) $('q-phone').value = q.phone || '';
    if($('q-email')) $('q-email').value = q.email || '';
    if($('q-addr')) $('q-addr').value = q.address || '';
    if($('q-project')) $('q-project').value = q.project_name || '';
    if($('q-scope-summary')) $('q-scope-summary').value = q.scope_summary || '';
    if($('q-notes')) $('q-notes').value = q.notes || '';
    if($('q-subtotal')) $('q-subtotal').value = q.subtotal || '';
    if($('q-tax')) $('q-tax').value = q.tax || '';
    if($('q-total')) $('q-total').value = q.total || '';
    if($('q-save-status')) $('q-save-status').textContent = '';
    // Phase 1A.1 additions
    if($('q-customer-id')) $('q-customer-id').value = q.customer_id || 0;
    if($('q-client-linked')) $('q-client-linked').style.display = q.customer_id ? 'block' : 'none';
    if($('q-client-newmode')) $('q-client-newmode').checked = false;
    if($('q-rep-display')) $('q-rep-display').textContent = q.rep_name || '—';
    if($('q-created-display')) $('q-created-display').textContent = q.created_at ? ('Created ' + fmtDate(q.created_at.split(' ')[0])) : '';
    const cpBtn = $('q-create-project-btn');
    if (cpBtn) cpBtn.style.display = (q.status === 'accepted') ? 'inline-block' : 'none';
    // Phase 1A.1.1 — lock the job number on saved quotes (already assigned)
    quotesResetNumEditState();
    const hint = $('q-num-hint'); if (hint) hint.textContent = 'assigned';
    const editBtn = $('q-num-edit-btn'); if (editBtn) editBtn.style.display = 'inline-block';
    $('q-scopes-container').innerHTML = '';
    $('q-options-container').innerHTML = '';
    quotesCurrentScopes.forEach(() => {});
    quotesRenderScopes();
    quotesRenderOptions();
    // Pre-load customer cache for search
    quotesLoadCustomerCache();
  } catch(e) { showToast('Error loading quote: ' + e.message, 'error'); }
}

async function quotesSave() {
  const statusEl = $('q-save-status');
  if (statusEl) statusEl.textContent = 'Saving...';
  const scopes = quotesGetScopes();
  const options = quotesGetOptions();
  const payload = {
    quote_number: $('q-num') ? $('q-num').value.trim() : '',
    customer_id: $('q-customer-id') ? (parseInt($('q-customer-id').value)||0) : 0,
    client_name: $('q-client') ? $('q-client').value.trim() : '',
    contact_name: $('q-contact') ? $('q-contact').value.trim() : '',
    phone: $('q-phone') ? $('q-phone').value.trim() : '',
    email: $('q-email') ? $('q-email').value.trim() : '',
    address: $('q-addr') ? $('q-addr').value.trim() : '',
    project_name: $('q-project') ? $('q-project').value.trim() : '',
    scope_summary: $('q-scope-summary') ? $('q-scope-summary').value.trim() : '',
    notes: $('q-notes') ? $('q-notes').value.trim() : '',
    subtotal: $('q-subtotal') ? $('q-subtotal').value.trim() : '',
    tax: $('q-tax') ? $('q-tax').value.trim() : '',
    total: $('q-total') ? $('q-total').value.trim() : '',
    valid_for: $('q-valid') ? $('q-valid').value.trim() : '30 days',
    status: $('q-status') ? $('q-status').value : 'draft',
    scopes, options
  };
  try {
    if (quotesCurrentId) {
      await api('PUT', '/api/quotes/' + quotesCurrentId, payload);
    } else {
      const r = await api('POST', '/api/quotes', payload);
      quotesCurrentId = r.id;
    }
    if (statusEl) statusEl.textContent = '✓ Saved ' + new Date().toLocaleTimeString();
    showToast('Quote saved!', 'success');
    // Update Create Project button visibility based on current status
    const cpBtn = $('q-create-project-btn');
    if (cpBtn) cpBtn.style.display = ($('q-status') && $('q-status').value === 'accepted') ? 'inline-block' : 'none';
  } catch(e) { if (statusEl) statusEl.textContent = '✗ Error'; showToast(e.message, 'error'); }
}

async function quotesDelete(id) {
  if (!confirm('Delete this quote?')) return;
  try { await api('DELETE', '/api/quotes/' + id); showToast('Quote deleted.', 'success'); quotesLoadList(); } catch(e) { showToast(e.message, 'error'); }
}

// ─── SCOPE BUILDER ───────────────────────────────────────────────────────────
function quotesAddScope() {
  quotesCurrentScopes.push({ title: '', lines: [{ desc: '', price: '' }] });
  quotesRenderScopes();
}

function quotesRenderScopes() {
  const el = $('q-scopes-container');
  if (!el) return;
  el.innerHTML = quotesCurrentScopes.map((sc, si) => `
    <div class="q-scope-block">
      <div class="q-scope-hdr">
        <input value="${sc.title||''}" placeholder="Section title (e.g. Door 1 — Overhead Door)" oninput="quotesCurrentScopes[${si}].title=this.value"
          style="flex:1;background:transparent;border:none;border-bottom:1px solid var(--amber);color:var(--white);font-size:13px;font-weight:600;padding:2px 0;outline:none;font-family:inherit" />
        <button class="q-rm-btn" onclick="quotesRemoveScope(${si})" title="Remove section">✕</button>
      </div>
      <div class="q-scope-body" id="q-scope-lines-${si}">
        ${(sc.lines||[]).map((ln, li) => `
          <div class="q-line-row">
            <input value="${ln.desc||''}" placeholder="Line item description" oninput="quotesCurrentScopes[${si}].lines[${li}].desc=this.value" style="flex:3" />
            <input value="${ln.price||''}" placeholder="$0.00" oninput="quotesCurrentScopes[${si}].lines[${li}].price=this.value;quotesCalcTotal()" style="flex:1;text-align:right;max-width:100px" />
            <button class="q-rm-btn" onclick="quotesRemoveLine(${si},${li})">✕</button>
          </div>`).join('')}
        <button class="q-add-line-btn" onclick="quotesAddLine(${si})">+ Add line</button>
      </div>
    </div>`).join('');
}

function quotesRemoveScope(si) { quotesCurrentScopes.splice(si,1); quotesRenderScopes(); }
function quotesAddLine(si) { quotesCurrentScopes[si].lines.push({desc:'',price:''}); quotesRenderScopes(); }
function quotesRemoveLine(si,li) { quotesCurrentScopes[si].lines.splice(li,1); quotesRenderScopes(); }

function quotesAddOption() {
  quotesCurrentOptions.push({ desc: '', price: '' });
  quotesRenderOptions();
}

function quotesRenderOptions() {
  const el = $('q-options-container');
  if (!el) return;
  el.innerHTML = quotesCurrentOptions.map((op, oi) => `
    <div class="q-line-row">
      <input value="${op.desc||''}" placeholder="Option description" oninput="quotesCurrentOptions[${oi}].desc=this.value" style="flex:3" />
      <input value="${op.price||''}" placeholder="$0.00" oninput="quotesCurrentOptions[${oi}].price=this.value;quotesCalcTotal()" style="flex:1;text-align:right;max-width:100px" />
      <button class="q-rm-btn" onclick="quotesCurrentOptions.splice(${oi},1);quotesRenderOptions()">✕</button>
    </div>`).join('');
}

function quotesGetScopes() { return quotesCurrentScopes; }
function quotesGetOptions() { return quotesCurrentOptions; }

function quotesCalcTotal() {
  let total = 0;
  quotesCurrentScopes.forEach(sc => (sc.lines||[]).forEach(ln => { const v=parseFloat((ln.price||'').replace(/[^0-9.]/g,'')); if(!isNaN(v)) total+=v; }));
  quotesCurrentOptions.forEach(op => { const v=parseFloat((op.price||'').replace(/[^0-9.]/g,'')); if(!isNaN(v)) total+=v; });
  const taxStr = $('q-tax') ? $('q-tax').value : '';
  const tax = parseFloat(taxStr.replace(/[^0-9.]/g,''))||0;
  if($('q-subtotal')) $('q-subtotal').value = total.toFixed(2);
  if($('q-total')) $('q-total').value = (total+tax).toFixed(2);
}

// ─── AI ASSISTANT ─────────────────────────────────────────────────────────────
function quotesHandleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  quotesCurrentFile = file;
  const tag = $('ai-file-preview-tag');
  if (tag) { tag.textContent = '📎 ' + file.name; tag.style.display = 'inline-block'; }
}

async function quotesRunAI() {
  const btn = $('ai-analyze-btn');
  const statusEl = $('ai-status-msg');
  const notes = $('ai-notes-input') ? $('ai-notes-input').value.trim() : '';
  if (!notes && !quotesCurrentFile) { if(statusEl) statusEl.textContent = 'Paste notes or upload a file first.'; return; }
  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.textContent = '🤖 Analyzing...'; statusEl.className = 'quotes-ai-status thinking'; }
  try {
    let messages;
    if (quotesCurrentFile) {
      const base64 = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=()=>rej(new Error('Read failed')); r.readAsDataURL(quotesCurrentFile); });
      const mt = quotesCurrentFile.type || 'image/jpeg';
      messages = [{ role:'user', content:[
        { type: mt==='application/pdf'?'document':'image', source:{ type:'base64', media_type:mt, data:base64 } },
        { type:'text', text: 'Extract all quote/estimate line items from this document. Return JSON only:\n{"client_name":"","contact_name":"","phone":"","email":"","address":"","project_name":"","scope_summary":"","scopes":[{"title":"","lines":[{"desc":"","price":""}]}],"subtotal":"","tax":"","total":"","notes":""}' }
      ]}];
    } else {
      messages = [{ role:'user', content: `Extract quote info from these notes and return JSON only:\n{"client_name":"","contact_name":"","phone":"","email":"","address":"","project_name":"","scope_summary":"","scopes":[{"title":"","lines":[{"desc":"","price":""}]}],"subtotal":"","tax":"","total":"","notes":""}\n\nNotes:\n${notes}` }];
    }
    const res = await fetch('/api/claude', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2000, messages }) });
    const data = await res.json();
    const text = (data.content||[]).map(c=>c.text||'').join('');
    const clean = text.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(clean);
    // Fill form
    if(parsed.client_name&&$('q-client')) $('q-client').value=parsed.client_name;
    if(parsed.contact_name&&$('q-contact')) $('q-contact').value=parsed.contact_name;
    if(parsed.phone&&$('q-phone')) $('q-phone').value=parsed.phone;
    if(parsed.email&&$('q-email')) $('q-email').value=parsed.email;
    if(parsed.address&&$('q-addr')) $('q-addr').value=parsed.address;
    if(parsed.project_name&&$('q-project')) $('q-project').value=parsed.project_name;
    if(parsed.scope_summary&&$('q-scope-summary')) $('q-scope-summary').value=parsed.scope_summary;
    if(parsed.notes&&$('q-notes')) $('q-notes').value=parsed.notes;
    if(parsed.subtotal&&$('q-subtotal')) $('q-subtotal').value=parsed.subtotal;
    if(parsed.tax&&$('q-tax')) $('q-tax').value=parsed.tax;
    if(parsed.total&&$('q-total')) $('q-total').value=parsed.total;
    if(parsed.scopes&&parsed.scopes.length) { quotesCurrentScopes=parsed.scopes; quotesRenderScopes(); }
    if(parsed.options&&parsed.options.length) { quotesCurrentOptions=parsed.options; quotesRenderOptions(); }
    if(statusEl) { statusEl.textContent='✓ Done! Review and adjust the quote below.'; statusEl.className='quotes-ai-status done'; }
  } catch(e) {
    if(statusEl) { statusEl.textContent='✗ Error: '+e.message; statusEl.className='quotes-ai-status error'; }
  } finally { if(btn) btn.disabled=false; }
}

// ─── PRINT QUOTE ─────────────────────────────────────────────────────────────
function quotesPrint() {
  const scopes = quotesGetScopes();
  const options = quotesGetOptions();
  const client = $('q-client')?$('q-client').value:'';
  const contact = $('q-contact')?$('q-contact').value:'';
  const phone = $('q-phone')?$('q-phone').value:'';
  const email = $('q-email')?$('q-email').value:'';
  const addr = $('q-addr')?$('q-addr').value:'';
  const project = $('q-project')?$('q-project').value:'';
  const qnum = $('q-num')?$('q-num').value:'';
  const qdate = $('q-date')?$('q-date').value:'';
  const valid = $('q-valid')?$('q-valid').value:'30 days';
  const notes = $('q-notes')?$('q-notes').value:'';
  const subtotal = $('q-subtotal')?$('q-subtotal').value:'';
  const tax = $('q-tax')?$('q-tax').value:'';
  const total = $('q-total')?$('q-total').value:'';
  const scopeSummary = $('q-scope-summary')?$('q-scope-summary').value:'';
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>KVM Quote ${qnum}</title>
  <style>
    body{font-family:Arial,sans-serif;color:#000;margin:0;padding:24px;font-size:13px}
    .logo-bar{background:#0d0d0d;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
    .logo-bar img{height:40px}
    .logo-bar .co{color:#fff;font-family:Arial,sans-serif;font-size:20px;font-weight:700;letter-spacing:2px}
    .logo-bar .doc-type{color:#F5A623;font-size:14px;font-weight:700;letter-spacing:1px}
    h2{font-size:14px;font-weight:700;border-bottom:2px solid #F5A623;padding-bottom:4px;margin:16px 0 8px;text-transform:uppercase}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
    .info-row{display:flex;gap:8px;margin-bottom:4px;font-size:12px}
    .info-label{font-weight:700;min-width:80px;color:#555}
    table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:12px}
    th{background:#f0f0f0;padding:7px 10px;text-align:left;font-weight:700;border:1px solid #ddd}
    td{padding:6px 10px;border:1px solid #eee}
    .section-title{background:#fafafa;font-weight:700;padding:6px 10px;border:1px solid #ddd;font-size:12px;color:#333}
    .totals{margin-left:auto;width:280px;margin-top:8px}
    .tot-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #eee}
    .tot-total{font-weight:700;font-size:15px;color:#000;border-top:2px solid #F5A623;padding-top:6px;margin-top:4px}
    .notes-box{background:#fafafa;border:1px solid #ddd;padding:12px;font-size:12px;margin-top:12px;white-space:pre-line}
    .footer{margin-top:24px;font-size:11px;color:#888;text-align:center;border-top:1px solid #eee;padding-top:8px}
    @media print{body{padding:0}}
  </style></head><body>
  <div class="logo-bar">
    <span class="co">KVM DOOR SYSTEMS</span>
    <span class="doc-type">QUOTE / PROPOSAL</span>
  </div>
  <div class="grid2">
    <div>
      <h2>Client Information</h2>
      <div class="info-row"><span class="info-label">Company</span><span>${client}</span></div>
      <div class="info-row"><span class="info-label">Contact</span><span>${contact}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span>${phone}</span></div>
      <div class="info-row"><span class="info-label">Email</span><span>${email}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span>${addr}</span></div>
      ${project?`<div class="info-row"><span class="info-label">Project</span><span><strong>${project}</strong></span></div>`:''}
    </div>
    <div>
      <h2>Quote Details</h2>
      <div class="info-row"><span class="info-label">Quote #</span><span><strong>${qnum}</strong></span></div>
      <div class="info-row"><span class="info-label">Date</span><span>${qdate?fmtDate(qdate):''}</span></div>
      <div class="info-row"><span class="info-label">Valid For</span><span>${valid}</span></div>
      ${scopeSummary?`<div class="info-row" style="margin-top:8px"><span class="info-label">Scope</span><span style="font-style:italic">${scopeSummary}</span></div>`:''}
    </div>
  </div>
  <h2>Scope of Work</h2>
  ${scopes.map(sc=>`
    ${sc.title?`<div class="section-title">${sc.title}</div>`:''}
    <table><tbody>${(sc.lines||[]).map(ln=>`<tr><td>${ln.desc||''}</td><td style="text-align:right;width:100px;font-weight:600">${ln.price?'$'+ln.price:''}</td></tr>`).join('')}</tbody></table>
  `).join('')}
  ${options&&options.length?`<h2>Options &amp; Add-Ons</h2>
    <table><tbody>${options.map(op=>`<tr><td>${op.desc||''}</td><td style="text-align:right;width:100px;font-weight:600">${op.price?'$'+op.price:''}</td></tr>`).join('')}</tbody></table>`:''}
  <div class="totals">
    ${subtotal?`<div class="tot-row"><span>Subtotal</span><span>$${subtotal}</span></div>`:''}
    ${tax?`<div class="tot-row"><span>Tax</span><span>$${tax}</span></div>`:''}
    <div class="tot-row tot-total"><span>Total Contract</span><span>$${total}</span></div>
  </div>
  ${notes?`<h2>Notes</h2><div class="notes-box">${notes}</div>`:''}
  <div class="footer">KVM Door Systems &mdash; This proposal is valid for ${valid} from the date issued. &mdash; Thank you for your business.</div>
  <script>window.onload=()=>window.print();</script>
  </body></html>`);
  win.document.close();
}

// Wire sales page into showPage on load
(function() {
  const origShowPage = showPage;
  // Patch: when navigating to sales, load quotes list
  const _sp = showPage;
  window._salesPageInited = false;
})();

// ═══ EXPOSE FUNCTIONS ON WINDOW FOR INLINE onclick HANDLERS ═══
try {
  ['showPage','doLogin','doLogout','toggleSidebar','openModal','closeModal','closeOnOverlay',
   'quotesNewQuote','quotesShowList','quotesSave','quotesPrint','quotesRunAI','quotesHandleFile',
   'quotesOpenEdit','quotesDelete','quotesFilter','quotesAddScope','quotesAddOption',
   'openAddProject','openEditProject','saveProject','deleteProject','openProjectDetail',
   'setProjectTab','openAddPhase','openEditPhase','savePhase','deletePhase',
   'openAddHours','saveProjectHours','deleteProjectHours','saveProjectNote','deleteProjectNote',
   'openAddCost','openEditCost','saveCost','deleteCost','openEditBudgets','saveBudgets',
   'openAiInvoice','processAiInvoice','confirmAiInvoice','calcCostTotal','onProjQuoteChange',
   'loadProjects','loadProjectDetail','renderProjectTab','renderCostTab',
   'openAddCustomer','openEditCustomer','saveCustomer','loadCustomers','openCustomerDetail',
   'setCustTab','togglePartnerFields','openAddSite','openEditSite','saveSite','deleteSite',
   'openAddContact','saveContact','deleteContact','openAddEquipment','saveEquipment','deleteEquipment',
   'savePartnerDoc','deletePartnerDoc','exportQBIIF','runQBImport',
   'saveAnnouncement','deleteAnnouncement','saveNews','deleteNews',
   'openOncallModal','saveOncall','deleteOncall','openSwapOncall','saveOncallSwap',
   'setOncallFilter','openAutoScheduleModal','applyAutoSchedule','previewSchedule',
   'saveRotationOrder','moveRotation','loadKVMSchedule',
   'renderDirectory','openPtoReqModal','submitPto','calcPtoDays','ptoCalShift','ptoJump',
   'ptoManualInput','ptoViewShift','renderPtoCalendar','setAdminPtoFilter','reviewPto',
   'saveBlackout','deleteBlackout','saveUser','deleteUser','openEditUser','saveEditUser',
   'openResetPw','adminResetPassword','changeMyPassword','filterEmployeeTable',
   'saveSmtpSettings','savePoSettings','testEmail','testDailyEmail','updatePoPreview',
   'saveGcalSettings','setDocFilter','setPolicyFilter','uploadDocument','deleteDoc',
   'uploadPolicy','deletePolicy','renderAllDocs','initTimeclock','toggleClockType',
   'doClockin','doClockout','loadMyTimecard','loadMyTimecardPage','loadAdminTimecards',
   'sendTimecardEmails','exportTimecardExcel','openEditTimeEntry','deleteTimeEntry',
   'resolveAlert','renderAlerts','initAdminAttendance','setAttendanceTab',
   'openCallinModal','openAttEventModal','saveCallin','saveAttendanceEvent',
   'deleteCallin','deleteAttEvent','openQuarterlyReport','loadQuarterlyReport',
   'printQuarterlyReport','runPerfectAttendanceCheck','postPerfectAttendance',
   'printPerfectAttendance','openSelfCallin','submitSelfCallin','openAwardAchievement',
   'saveAchievement','refreshAttendanceBrief',
   // Phase 1A additions
   'setSettingsTab','downloadDbBackup','renderSkillsCheckboxes','toggleAllSkills',
   'collectCheckedSkills','renderWorkTypesCheckboxes','collectCheckedWorkTypes',
   'loadSkillsAdmin','openAddSkill','openEditSkill','saveSkill','deleteSkill',
   'loadTrucksAdmin','openAddTruck','openEditTruck','saveTruck','deleteTruck','onTruckRowTypeChange',
   'loadCoaAdmin','openAddCoa','openEditCoa','saveCoa','deleteCoa','openCoaUpload','processCoaUpload',
   'loadGlDefaults','saveGlDefaults'
  ].forEach(function(name){
    try { if (typeof eval(name) === 'function') window[name] = eval(name); } catch(e) {}
  });
  console.log('[KVM] Functions exposed on window');
} catch(e) { console.error('[KVM] Exposure failed:', e); }

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A — FOUNDATIONS: Settings sub-tabs, Skills, Trucks, CoA, Backup ══
// ═══════════════════════════════════════════════════════════════════════════════

// Caches
let _skillsCache = null;
let _skillCategoriesCache = null;
let _workTypesCache = null;
let _billCategoriesCache = null;
let _revenueDeptsCache = null;

async function loadSkillsCache() {
  if (_skillsCache && _skillCategoriesCache) return;
  try { _skillsCache = await api('GET','/api/skills'); } catch(e){ _skillsCache = []; }
  try { _skillCategoriesCache = await api('GET','/api/skillcategories'); } catch(e){ _skillCategoriesCache = []; }
}
async function loadWorkTypesCache() {
  if (_workTypesCache) return;
  try { _workTypesCache = await api('GET','/api/worktypes'); } catch(e){ _workTypesCache = []; }
}
async function loadBillCategoriesCache() {
  if (_billCategoriesCache) return;
  try { _billCategoriesCache = await api('GET','/api/billcategories'); } catch(e){ _billCategoriesCache = []; }
}

// ─── Settings sub-tabs ───────────────────────────────────────────────────────
function setSettingsTab(tab, el) {
  document.querySelectorAll('.settings-subpage').forEach(p => p.style.display = 'none');
  document.querySelectorAll('[data-settings-tab]').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('settings-sub-' + tab);
  if (panel) panel.style.display = 'block';
  if (el) el.classList.add('active');
  // Lazy-load content per tab
  if (tab === 'skills') loadSkillsAdmin();
  if (tab === 'trucks') loadTrucksAdmin();
  if (tab === 'gl')     loadGlDefaults();
  if (tab === 'coa')    loadCoaAdmin();
  if (tab === 'backup') refreshTestDataStatus();
}

// ─── Skills checkboxes (used on employee + project modals) ───────────────────
async function renderSkillsCheckboxes(prefix, selectedKeys) {
  await loadSkillsCache();
  const el = document.getElementById(prefix === 'edit' ? 'editSkillsGroups' : 'projModalRequiredSkills');
  if (!el) return;
  const selected = new Set((selectedKeys||[]).map(String));
  const byCat = {};
  (_skillsCache||[]).forEach(s => {
    const c = s.category || 'other';
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(s);
  });
  const cats = (_skillCategoriesCache||[]).slice();
  // Include any categories not in the master list (defensive)
  Object.keys(byCat).forEach(k => { if (!cats.find(c => c.key === k)) cats.push({key:k,label:k}); });

  let html = '';
  cats.forEach(cat => {
    const items = byCat[cat.key] || [];
    if (!items.length) return;
    html += `<div style="margin-bottom:.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;font-family:Oswald,sans-serif;font-size:12px;letter-spacing:1px;color:var(--amber);text-transform:uppercase;margin-bottom:4px;padding-bottom:2px;border-bottom:1px solid var(--border)">
        <span>${cat.label}</span>
        <label style="font-size:10px;font-weight:normal;color:var(--text-muted);cursor:pointer;text-transform:none;letter-spacing:0">
          <input type="checkbox" class="skill-cat-checkall" data-prefix="${prefix}" data-cat="${cat.key}" onchange="toggleCategorySkills('${prefix}','${cat.key}',this.checked)" />
          <span>Check category</span>
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px">
        ${items.map(s => `<label style="display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:13px;cursor:pointer;border-radius:4px;${selected.has(s.skill_key)?'background:var(--amber-bg2);border:1px solid var(--amber-dim)':'border:1px solid transparent'}">
          <input type="checkbox" class="skill-chk" data-prefix="${prefix}" data-cat="${cat.key}" value="${s.skill_key}" ${selected.has(s.skill_key)?'checked':''} onchange="this.closest('label').style.background=this.checked?'var(--amber-bg2)':'transparent';this.closest('label').style.border='1px solid '+(this.checked?'var(--amber-dim)':'transparent')" />
          <span>${s.label}</span>
        </label>`).join('')}
      </div>
    </div>`;
  });
  if (!html) html = '<div style="font-size:12px;color:var(--text-muted);padding:.5rem">No skills defined. An admin can add them in Settings → Skills.</div>';
  el.innerHTML = html;
}

function toggleAllSkills(prefix, checked) {
  const container = document.getElementById(prefix === 'edit' ? 'editSkillsGroups' : 'projModalRequiredSkills');
  if (!container) return;
  container.querySelectorAll('input.skill-chk').forEach(cb => {
    cb.checked = checked;
    const lbl = cb.closest('label');
    if (lbl) {
      lbl.style.background = checked ? 'var(--amber-bg2)' : 'transparent';
      lbl.style.border = '1px solid ' + (checked ? 'var(--amber-dim)' : 'transparent');
    }
  });
  container.querySelectorAll('input.skill-cat-checkall').forEach(cb => { cb.checked = checked; });
}

function toggleCategorySkills(prefix, cat, checked) {
  const container = document.getElementById(prefix === 'edit' ? 'editSkillsGroups' : 'projModalRequiredSkills');
  if (!container) return;
  container.querySelectorAll('input.skill-chk[data-cat="'+cat+'"]').forEach(cb => {
    cb.checked = checked;
    const lbl = cb.closest('label');
    if (lbl) {
      lbl.style.background = checked ? 'var(--amber-bg2)' : 'transparent';
      lbl.style.border = '1px solid ' + (checked ? 'var(--amber-dim)' : 'transparent');
    }
  });
}

function collectCheckedSkills(prefix) {
  const container = document.getElementById(prefix === 'edit' ? 'editSkillsGroups' : 'projModalRequiredSkills');
  if (!container) return [];
  return Array.from(container.querySelectorAll('input.skill-chk:checked')).map(cb => cb.value);
}

// ─── Work Types checkboxes (project modal) ───────────────────────────────────
async function renderWorkTypesCheckboxes(selectedKeys) {
  await loadWorkTypesCache();
  const el = document.getElementById('projModalWorkTypes');
  if (!el) return;
  const selected = new Set((selectedKeys||[]).map(String));
  el.innerHTML = (_workTypesCache||[]).map(w =>
    `<label style="display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:13px;cursor:pointer;border-radius:4px;${selected.has(w.key)?'background:var(--amber-bg2);border:1px solid var(--amber-dim)':'border:1px solid var(--border)'}">
      <input type="checkbox" class="worktype-chk" value="${w.key}" ${selected.has(w.key)?'checked':''} onchange="this.closest('label').style.background=this.checked?'var(--amber-bg2)':'transparent';this.closest('label').style.borderColor=this.checked?'var(--amber-dim)':'var(--border)'" />
      <span>${w.label}</span>
    </label>`
  ).join('');
}

function collectCheckedWorkTypes() {
  const el = document.getElementById('projModalWorkTypes');
  if (!el) return [];
  return Array.from(el.querySelectorAll('input.worktype-chk:checked')).map(cb => cb.value);
}

// ─── DB Backup ───────────────────────────────────────────────────────────────
function downloadDbBackup() {
  // Triggers a file download from the server. Must be a direct link, not an XHR.
  try {
    const a = document.createElement('a');
    a.href = '/api/admin/db-backup';
    a.download = 'kvm-db-backup.db';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download starting...', 'success');
  } catch(e) { showToast('Download failed: ' + e.message, 'error'); }
}

// ─── Skills Admin (Settings → Skills tab) ─────────────────────────────────────
async function loadSkillsAdmin() {
  const el = document.getElementById('skillsAdminList');
  if (!el) return;
  _skillsCache = null; // invalidate so fresh pull
  _skillCategoriesCache = null;
  await loadSkillsCache();
  const skills = _skillsCache || [];
  const cats = _skillCategoriesCache || [];
  if (!skills.length) { el.innerHTML = '<div class="empty-state">No skills defined.</div>'; return; }
  const byCat = {};
  skills.forEach(s => { const c = s.category||'other'; if (!byCat[c]) byCat[c]=[]; byCat[c].push(s); });
  let html = '';
  const catOrder = cats.slice();
  Object.keys(byCat).forEach(k => { if (!catOrder.find(c => c.key === k)) catOrder.push({key:k,label:k}); });
  catOrder.forEach(cat => {
    const items = byCat[cat.key] || [];
    if (!items.length) return;
    html += `<div style="margin-bottom:1rem">
      <div style="font-family:Oswald,sans-serif;font-size:13px;letter-spacing:1px;color:var(--amber);text-transform:uppercase;margin-bottom:.5rem">${cat.label}</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th style="width:40px">#</th><th>Label</th><th>Key</th><th style="width:80px">Sort</th><th style="width:160px">Actions</th></tr></thead><tbody>
        ${items.map(s => `<tr>
          <td>${s.id}</td>
          <td>${s.label}</td>
          <td style="font-family:monospace;font-size:12px;color:var(--text-muted)">${s.skill_key}</td>
          <td>${s.sort_order||0}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="openEditSkill(${s.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteSkill(${s.id})">Remove</button></td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>`;
  });
  el.innerHTML = html;
}
function openAddSkill() {
  $('skillModalId').value = '';
  $('skillModalTitle').textContent = 'Add Skill';
  $('skillModalLabel').value = '';
  $('skillModalKey').value = '';
  $('skillModalKey').disabled = false;
  $('skillModalCategory').value = 'doors_sectional_coiling';
  $('skillModalSort').value = 10;
  $('skillModalActive').value = '1';
  openModal('skillModal');
}
function openEditSkill(id) {
  const s = (_skillsCache||[]).find(x => x.id === id);
  if (!s) return;
  $('skillModalId').value = s.id;
  $('skillModalTitle').textContent = 'Edit Skill';
  $('skillModalLabel').value = s.label || '';
  $('skillModalKey').value = s.skill_key || '';
  $('skillModalKey').disabled = true; // key immutable
  $('skillModalCategory').value = s.category || 'doors_sectional_coiling';
  $('skillModalSort').value = s.sort_order || 10;
  $('skillModalActive').value = s.active ? '1' : '0';
  openModal('skillModal');
}
async function saveSkill() {
  const id = $('skillModalId').value;
  const label = $('skillModalLabel').value.trim();
  const skill_key = $('skillModalKey').value.trim();
  const category = $('skillModalCategory').value;
  const sort_order = parseInt($('skillModalSort').value)||0;
  const active = $('skillModalActive').value === '1';
  if (!label || !skill_key) return showToast('Label and key are required.', 'error');
  try {
    if (id) {
      await api('PUT','/api/skills/'+id,{ label, category, sort_order, active });
    } else {
      await api('POST','/api/skills',{ skill_key, label, category, sort_order });
    }
    closeModal('skillModal');
    showToast('Skill saved.','success');
    _skillsCache = null;
    loadSkillsAdmin();
  } catch(e) { showToast(e.message,'error'); }
}
async function deleteSkill(id) {
  if (!confirm('Remove this skill? It will be hidden from future use but preserved for historical records.')) return;
  try { await api('DELETE','/api/skills/'+id); _skillsCache = null; showToast('Skill removed.','success'); loadSkillsAdmin(); }
  catch(e) { showToast(e.message,'error'); }
}

// ─── Trucks Admin (Settings → Trucks tab) ─────────────────────────────────────
async function loadTrucksAdmin() {
  const el = document.getElementById('trucksAdminList');
  if (!el) return;
  try {
    const trucks = await api('GET','/api/trucks');
    if (!trucks.length) { el.innerHTML = '<div class="empty-state">No trucks/crews defined yet. Click "+ Add Truck" to get started.</div>'; return; }
    const fmtType = t => ({truck:'Truck',shop:'Shop',delivery:'Delivery',flex:'Flex',temp_crew:'Temp Crew'}[t]||t);
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th style="width:50px">#</th><th style="width:50px">Sort</th><th>Lead / Label</th><th style="width:110px">Type</th><th>Notes</th><th style="width:110px">Status</th><th style="width:160px">Actions</th></tr></thead>
      <tbody>
        ${trucks.map(t => {
          const label = t.row_type === 'truck' || t.row_type === 'temp_crew'
            ? (t.lead_name || '<em style="color:var(--text-muted)">(no lead assigned)</em>')
            : fmtType(t.row_type);
          const dateInfo = t.row_type === 'temp_crew' && (t.temp_start_date||t.temp_end_date)
            ? `<div style="font-size:11px;color:var(--text-muted)">${t.temp_start_date||'?'} → ${t.temp_end_date||'?'}</div>` : '';
          return `<tr style="${t.active?'':'opacity:.5'}">
            <td>${t.id}</td>
            <td>${t.sort_order||0}</td>
            <td>${label}${dateInfo}</td>
            <td>${fmtType(t.row_type)}</td>
            <td>${t.notes||''}</td>
            <td><span class="badge ${t.active?'badge-green':'badge-gray'}">${t.active?'Active':'Inactive'}</span></td>
            <td><button class="btn btn-ghost btn-sm" onclick="openEditTruck(${t.id})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteTruck(${t.id})">Remove</button></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;
  } catch(e) { el.innerHTML = '<div class="alert alert-danger">Error loading trucks: ' + e.message + '</div>'; }
}
async function populateTruckLeadDropdown(selectedId) {
  if (!allUsers.length) try { allUsers = await api('GET','/api/users'); } catch(e){}
  const sel = $('truckModalLead');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select Lead —</option>' +
    allUsers.filter(u => !['global_admin'].includes(u.role_type||''))
      .map(u => `<option value="${u.id}" ${String(u.id)===String(selectedId)?'selected':''}>${displayName(u)}</option>`).join('');
}
function onTruckRowTypeChange() {
  const rt = $('truckModalRowType').value;
  const isCrew = (rt === 'truck' || rt === 'temp_crew');
  $('truckModalLeadWrap').style.display = isCrew ? 'block' : 'none';
  $('truckModalTempDateRow').style.display = rt === 'temp_crew' ? 'flex' : 'none';
}
async function openAddTruck() {
  $('truckModalId').value = '';
  $('truckModalTitle').textContent = 'Add Truck';
  $('truckModalRowType').value = 'truck';
  $('truckModalSort').value = 10;
  $('truckModalActive').value = '1';
  $('truckModalNotes').value = '';
  $('truckModalTempStart').value = '';
  $('truckModalTempEnd').value = '';
  await populateTruckLeadDropdown('');
  onTruckRowTypeChange();
  openModal('truckModal');
}
async function openEditTruck(id) {
  try {
    const trucks = await api('GET','/api/trucks');
    const t = trucks.find(x => x.id === id);
    if (!t) return showToast('Truck not found.','error');
    $('truckModalId').value = t.id;
    $('truckModalTitle').textContent = 'Edit Truck';
    $('truckModalRowType').value = t.row_type || 'truck';
    $('truckModalSort').value = t.sort_order || 10;
    $('truckModalActive').value = t.active ? '1' : '0';
    $('truckModalNotes').value = t.notes || '';
    $('truckModalTempStart').value = t.temp_start_date || '';
    $('truckModalTempEnd').value = t.temp_end_date || '';
    await populateTruckLeadDropdown(t.lead_user_id);
    onTruckRowTypeChange();
    openModal('truckModal');
  } catch(e) { showToast(e.message,'error'); }
}
async function saveTruck() {
  const id = $('truckModalId').value;
  const payload = {
    lead_user_id: parseInt($('truckModalLead').value)||0,
    sort_order:   parseInt($('truckModalSort').value)||0,
    row_type:     $('truckModalRowType').value,
    notes:        $('truckModalNotes').value.trim(),
    temp_start_date: $('truckModalTempStart').value || '',
    temp_end_date:   $('truckModalTempEnd').value || '',
    active:       $('truckModalActive').value === '1'
  };
  try {
    if (id) await api('PUT','/api/trucks/'+id,payload);
    else    await api('POST','/api/trucks',payload);
    closeModal('truckModal');
    showToast('Truck saved.','success');
    loadTrucksAdmin();
  } catch(e) { showToast(e.message,'error'); }
}
async function deleteTruck(id) {
  if (!confirm('Remove this truck? It will be hidden but historical schedule data will be preserved.')) return;
  try { await api('DELETE','/api/trucks/'+id); showToast('Truck removed.','success'); loadTrucksAdmin(); }
  catch(e) { showToast(e.message,'error'); }
}

// ─── Chart of Accounts Admin (Settings → CoA tab) ────────────────────────────
async function loadCoaAdmin() {
  const el = document.getElementById('coaAdminList');
  if (!el) return;
  try {
    const accounts = await api('GET','/api/chart-of-accounts');
    if (!accounts.length) {
      el.innerHTML = '<div class="empty-state">No accounts yet. Upload your QuickBooks Chart of Accounts or add accounts manually.</div>';
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th style="width:120px">Number</th><th>Name</th><th style="width:180px">Type</th><th style="width:160px">Actions</th></tr></thead>
      <tbody>
        ${accounts.map(a => `<tr>
          <td>${a.account_number||''}</td>
          <td>${a.account_name}</td>
          <td>${a.account_type||''}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="openEditCoa(${a.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteCoa(${a.id})">Remove</button></td>
        </tr>`).join('')}
      </tbody></table></div>`;
  } catch(e) { el.innerHTML = '<div class="alert alert-danger">Error loading accounts: ' + e.message + '</div>'; }
}
function openAddCoa() {
  $('coaModalId').value = '';
  $('coaModalTitle').textContent = 'Add Account';
  $('coaModalNumber').value = '';
  $('coaModalName').value = '';
  $('coaModalType').value = '';
  $('coaModalSort').value = 0;
  $('coaModalActive').value = '1';
  openModal('coaModal');
}
async function openEditCoa(id) {
  try {
    const accounts = await api('GET','/api/chart-of-accounts');
    const a = accounts.find(x => x.id === id);
    if (!a) return;
    $('coaModalId').value = a.id;
    $('coaModalTitle').textContent = 'Edit Account';
    $('coaModalNumber').value = a.account_number||'';
    $('coaModalName').value = a.account_name||'';
    $('coaModalType').value = a.account_type||'';
    $('coaModalSort').value = a.sort_order||0;
    $('coaModalActive').value = a.active ? '1' : '0';
    openModal('coaModal');
  } catch(e) { showToast(e.message,'error'); }
}
async function saveCoa() {
  const id = $('coaModalId').value;
  const payload = {
    account_number: $('coaModalNumber').value.trim(),
    account_name:   $('coaModalName').value.trim(),
    account_type:   $('coaModalType').value,
    sort_order:     parseInt($('coaModalSort').value)||0,
    active:         $('coaModalActive').value === '1'
  };
  if (!payload.account_name) return showToast('Account name is required.','error');
  try {
    if (id) await api('PUT','/api/chart-of-accounts/'+id,payload);
    else    await api('POST','/api/chart-of-accounts',payload);
    closeModal('coaModal');
    showToast('Account saved.','success');
    loadCoaAdmin();
  } catch(e) { showToast(e.message,'error'); }
}
async function deleteCoa(id) {
  if (!confirm('Remove this account?')) return;
  try { await api('DELETE','/api/chart-of-accounts/'+id); showToast('Account removed.','success'); loadCoaAdmin(); }
  catch(e) { showToast(e.message,'error'); }
}
function openCoaUpload() {
  $('coaUploadText').value = '';
  $('coaUploadReplace').checked = false;
  $('coaUploadStatus').textContent = '';
  openModal('coaUploadModal');
}
async function processCoaUpload() {
  const text = ($('coaUploadText').value || '').trim();
  const replace = $('coaUploadReplace').checked;
  const status = $('coaUploadStatus');
  if (!text) { status.innerHTML = '<span style="color:var(--danger)">Paste file content first.</span>'; return; }
  status.innerHTML = 'Parsing...';
  // Parse: IIF (ACCNT rows) OR CSV (Account Number,Account Name,Type)
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const rows = [];
  // Detect IIF
  const isIIF = lines.some(l => l.startsWith('!ACCNT') || l.startsWith('ACCNT\t'));
  if (isIIF) {
    let headers = null;
    lines.forEach(l => {
      const parts = l.split('\t');
      if (parts[0] === '!ACCNT') { headers = parts; return; }
      if (parts[0] === 'ACCNT' && headers) {
        const name = parts[headers.indexOf('NAME')] || '';
        const type = parts[headers.indexOf('ACCNTTYPE')] || '';
        const num  = parts[headers.indexOf('ACCNUM')] || '';
        if (name) rows.push({ account_number: num.trim(), account_name: name.trim(), account_type: type.trim() });
      }
    });
  } else {
    // CSV — detect header
    const first = lines[0].toLowerCase();
    const hasHeader = first.includes('account') && (first.includes('name') || first.includes('number'));
    const dataLines = hasHeader ? lines.slice(1) : lines;
    dataLines.forEach(l => {
      // Simple CSV split — doesn't handle quoted commas perfectly but covers 90% of QB exports
      const parts = l.split(',').map(p => p.trim().replace(/^"|"$/g,''));
      if (parts.length < 1 || !parts[0]) return;
      const row = { account_number: '', account_name: '', account_type: '' };
      if (parts.length === 1) { row.account_name = parts[0]; }
      else if (parts.length === 2) { row.account_number = parts[0]; row.account_name = parts[1]; }
      else { row.account_number = parts[0]; row.account_name = parts[1]; row.account_type = parts[2]||''; }
      if (row.account_name) rows.push(row);
    });
  }
  if (!rows.length) { status.innerHTML = '<span style="color:var(--danger)">No account rows detected.</span>'; return; }
  status.innerHTML = 'Found ' + rows.length + ' accounts. Importing...';
  try {
    if (replace) {
      const existing = await api('GET','/api/chart-of-accounts');
      for (const a of existing) { try { await api('DELETE','/api/chart-of-accounts/'+a.id); } catch(e){} }
    }
    let ok = 0, fail = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await api('POST','/api/chart-of-accounts', { ...rows[i], sort_order: i*10 });
        ok++;
      } catch(e) { fail++; }
    }
    status.innerHTML = '<span style="color:var(--green)">Imported ' + ok + ' accounts' + (fail?' (' + fail + ' failed)':'') + '.</span>';
    loadCoaAdmin();
    setTimeout(() => closeModal('coaUploadModal'), 1500);
  } catch(e) { status.innerHTML = '<span style="color:var(--danger)">' + e.message + '</span>'; }
}

// ─── GL Defaults (Settings → GL tab) ──────────────────────────────────────────
async function loadGlDefaults() {
  const el = document.getElementById('glDefaultsForm');
  if (!el) return;
  await loadBillCategoriesCache();
  let defaults = {};
  try { defaults = await api('GET','/api/gl-defaults'); } catch(e){}
  el.innerHTML = (_billCategoriesCache||[]).map(c => `
    <div class="form-group">
      <label>${c.label}</label>
      <input type="text" data-glcat="${c.key}" value="${(defaults[c.key]||'').replace(/"/g,'&quot;')}" placeholder="e.g. 5100 · COGS — ${c.label}" />
    </div>
  `).join('');
}
async function saveGlDefaults() {
  const form = document.getElementById('glDefaultsForm');
  if (!form) return;
  const payload = {};
  form.querySelectorAll('input[data-glcat]').forEach(inp => {
    payload[inp.getAttribute('data-glcat')] = inp.value;
  });
  try { await api('PUT','/api/gl-defaults',payload); showToast('GL defaults saved.','success'); }
  catch(e) { showToast(e.message,'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.1 — QUOTE WORKFLOW (customer search, rep display, create project) 
// ═══════════════════════════════════════════════════════════════════════════════

let _quotesCustomerCache = null;

async function quotesLoadCustomerCache() {
  if (_quotesCustomerCache) return _quotesCustomerCache;
  try { _quotesCustomerCache = await api('GET', '/api/customers'); }
  catch(e) { _quotesCustomerCache = []; }
  return _quotesCustomerCache;
}

function quotesToggleClientMode(newMode) {
  const input = $('q-client');
  const dropdown = $('q-client-dropdown');
  const linked = $('q-client-linked');
  if (newMode) {
    // "Type new" mode — disable search, clear customer_id, update placeholder
    if (input) input.placeholder = 'Type new customer name (not in list)';
    if (dropdown) dropdown.style.display = 'none';
    if ($('q-customer-id')) $('q-customer-id').value = '0';
    if (linked) linked.style.display = 'none';
  } else {
    if (input) input.placeholder = 'Start typing to search customers...';
  }
}

async function quotesCustomerSearchInput() {
  // Skip search if "type new" mode is on
  const newMode = $('q-client-newmode') && $('q-client-newmode').checked;
  if (newMode) return;
  const input = $('q-client');
  const dropdown = $('q-client-dropdown');
  if (!input || !dropdown) return;
  const q = input.value.trim().toLowerCase();
  // If user edited the name after linking, clear the link
  if ($('q-customer-id') && parseInt($('q-customer-id').value) > 0) {
    const cache = _quotesCustomerCache || [];
    const linkedCust = cache.find(c => c.id === parseInt($('q-customer-id').value));
    if (linkedCust && (linkedCust.company_name||'').toLowerCase() !== q) {
      $('q-customer-id').value = '0';
      if ($('q-client-linked')) $('q-client-linked').style.display = 'none';
    }
  }
  await quotesLoadCustomerCache();
  const cache = _quotesCustomerCache || [];
  if (!q) {
    // Show a few recent customers
    const recent = cache.slice(0, 8);
    if (!recent.length) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = recent.map(c => quotesCustomerOption(c)).join('');
    dropdown.style.display = 'block';
    return;
  }
  const matches = cache.filter(c => (c.company_name||'').toLowerCase().includes(q)).slice(0, 15);
  if (!matches.length) {
    dropdown.innerHTML = `<div style="padding:8px 10px;font-size:12px;color:var(--text-muted)">
      No matches. <label style="color:var(--amber);cursor:pointer;text-decoration:underline" onclick="$('q-client-newmode').checked=true;quotesToggleClientMode(true);">Type as new customer</label>
    </div>`;
    dropdown.style.display = 'block';
    return;
  }
  dropdown.innerHTML = matches.map(c => quotesCustomerOption(c)).join('');
  dropdown.style.display = 'block';
}

function quotesCustomerOption(c) {
  const sub = [c.billing_city, c.billing_state].filter(Boolean).join(', ');
  return `<div style="padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px" 
    onmousedown="event.preventDefault();quotesCustomerPick(${c.id})"
    onmouseover="this.style.background='var(--bg-surface)'" onmouseout="this.style.background='transparent'">
    <div style="font-weight:600">${escapeHtml(c.company_name||'—')}</div>
    ${sub ? `<div style="font-size:11px;color:var(--text-muted)">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function quotesCustomerSearchBlur() {
  const dd = $('q-client-dropdown');
  if (dd) dd.style.display = 'none';
}

async function quotesCustomerPick(customerId) {
  await quotesLoadCustomerCache();
  const c = (_quotesCustomerCache||[]).find(x => x.id === customerId);
  if (!c) return;
  if ($('q-customer-id')) $('q-customer-id').value = c.id;
  if ($('q-client')) $('q-client').value = c.company_name || '';
  // Auto-fill billing address
  const addrParts = [c.billing_address, c.billing_city ? (c.billing_city + (c.billing_state?', '+c.billing_state:'') + (c.billing_zip?' '+c.billing_zip:'')) : ''].filter(Boolean);
  if ($('q-addr') && !$('q-addr').value.trim()) $('q-addr').value = addrParts.join(', ');
  if ($('q-phone') && !$('q-phone').value.trim()) $('q-phone').value = c.billing_phone || '';
  if ($('q-email') && !$('q-email').value.trim()) $('q-email').value = c.billing_email || '';
  // Try to fetch a contact name if missing
  if ($('q-contact') && !$('q-contact').value.trim()) {
    try {
      const full = await api('GET', '/api/customers/' + c.id);
      if (full.contacts && full.contacts.length) {
        const primary = full.contacts.find(ct => ct.is_primary) || full.contacts[0];
        $('q-contact').value = ((primary.first_name||'') + ' ' + (primary.last_name||'')).trim();
        if (!$('q-phone').value.trim() && primary.phone) $('q-phone').value = primary.phone;
        if (!$('q-email').value.trim() && primary.email) $('q-email').value = primary.email;
      }
    } catch(e){}
  }
  if ($('q-client-linked')) $('q-client-linked').style.display = 'block';
  const dd = $('q-client-dropdown');
  if (dd) dd.style.display = 'none';
  showToast('Linked to customer record.','success');
}

function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function quotesCreateProjectFromQuote() {
  if (!quotesCurrentId) { showToast('Save the quote first.','error'); return; }
  const status = $('q-status') ? $('q-status').value : '';
  if (status !== 'accepted') {
    if (!confirm('Quote status is not "Accepted." Continue anyway?')) return;
  }
  // Phase 1A.2a — open chooser modal instead of direct create
  cfqOpen();
}

// Expose Phase 1A.1 functions on window for inline onclick handlers
(function() {
  try {
    ['quotesLoadCustomerCache','quotesToggleClientMode','quotesCustomerSearchInput',
     'quotesCustomerSearchBlur','quotesCustomerPick','quotesCreateProjectFromQuote',
     'escapeHtml'
    ].forEach(function(name){
      try { if (typeof eval(name) === 'function') window[name] = eval(name); } catch(e) {}
    });
    console.log('[KVM] Phase 1A.1 functions exposed');
  } catch(e) { console.error('[KVM] Phase 1A.1 exposure failed:', e); }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.1.1 — AUTO JOB NUMBERS (quote #, shared counter) ════════════════
// ═══════════════════════════════════════════════════════════════════════════════

function quotesResetNumEditState() {
  const input = $('q-num');
  const editBtn = $('q-num-edit-btn');
  const hint = $('q-num-hint');
  if (input) { input.readOnly = true; input.style.background = 'var(--bg-surface)'; input.style.cursor = 'default'; }
  if (editBtn) { editBtn.textContent = '\u270E'; editBtn.title = 'Override auto-assigned number'; }
  if (hint) hint.textContent = 'auto-assigned';
}

function quotesToggleNumEdit() {
  const input = $('q-num');
  const editBtn = $('q-num-edit-btn');
  const hint = $('q-num-hint');
  if (!input) return;
  if (input.readOnly) {
    // Unlock for edit
    input.readOnly = false;
    input.style.background = 'var(--bg-card)';
    input.style.cursor = 'text';
    input.focus();
    input.select();
    if (editBtn) { editBtn.textContent = '\u2713'; editBtn.title = 'Lock number'; }
    if (hint) hint.textContent = 'manual override — will be saved as-typed';
  } else {
    // Re-lock (keep current value — don't fetch new)
    input.readOnly = true;
    input.style.background = 'var(--bg-surface)';
    input.style.cursor = 'default';
    if (editBtn) { editBtn.textContent = '\u270E'; editBtn.title = 'Override auto-assigned number'; }
    if (hint) hint.textContent = input.value ? 'locked' : 'auto-assigned';
  }
}

async function quotesPrefillNextJobNumber() {
  const input = $('q-num');
  if (!input) return;
  // Don't overwrite a user-supplied value
  if (input.value.trim()) return;
  try {
    const res = await api('GET', '/api/job-number/peek');
    if (res && res.next_number) {
      input.value = res.next_number;
      input.placeholder = res.next_number;
    }
  } catch(e) {
    // Silent — server will assign on save anyway
    console.warn('Job number peek failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.1.2 — TEST DATA SEED / PURGE (Settings → Backup tab) ════════════
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshTestDataStatus() {
  const box = $('test-data-status');
  const seedBtn = $('btn-seed-test-data');
  const purgeBtn = $('btn-purge-test-data');
  if (!box) return;
  try {
    const r = await api('GET', '/api/test-data/status');
    if (r.has_test_data) {
      const parts = [];
      Object.keys(r.counts || {}).forEach(k => { if (r.counts[k] > 0) parts.push(r.counts[k] + ' ' + k); });
      box.innerHTML = '<span style="color:var(--green)">&#10003;</span> <strong>' + r.total + ' test records</strong> present: ' + parts.join(', ');
      if (seedBtn) seedBtn.style.display = 'none';
      if (purgeBtn) purgeBtn.style.display = 'inline-block';
    } else {
      box.innerHTML = 'No test data currently seeded.';
      if (seedBtn) seedBtn.style.display = 'inline-block';
      if (purgeBtn) purgeBtn.style.display = 'none';
    }
  } catch(e) {
    box.innerHTML = '<span style="color:var(--danger)">Error: ' + e.message + '</span>';
  }
}

async function seedTestData() {
  if (!confirm('Seed realistic test customers, sites, contacts, quotes, and projects into the database?\n\nEvery seeded record is tagged so it can be cleanly removed later via "Purge All Test Data." All names are prefixed with "(TEST)" for easy identification.')) return;
  const btn = $('btn-seed-test-data');
  if (btn) { btn.disabled = true; btn.textContent = 'Seeding...'; }
  try {
    const r = await api('POST', '/api/test-data/seed', {});
    const parts = [];
    Object.keys(r.seeded || {}).forEach(k => { if (r.seeded[k] > 0) parts.push(r.seeded[k] + ' ' + k); });
    showToast('Seeded: ' + parts.join(', '), 'success');
    await refreshTestDataStatus();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '&#10133; Seed Test Data'; }
  }
}

async function purgeTestData() {
  if (!confirm('DELETE ALL TEST DATA from the database?\n\nThis will remove every record tagged as test data (prefixed with "(TEST)") — customers, sites, contacts, quotes, and projects. Real data is not affected.\n\nThis cannot be undone without restoring a backup.')) return;
  if (!confirm('Really purge all test data? Type-sensitive check: click OK to confirm.')) return;
  const btn = $('btn-purge-test-data');
  if (btn) { btn.disabled = true; btn.textContent = 'Purging...'; }
  try {
    const r = await api('POST', '/api/test-data/purge', {});
    const total = Object.values(r.deleted || {}).reduce((a,b)=>a+b, 0);
    showToast('Purged ' + total + ' test records.', 'success');
    await refreshTestDataStatus();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '&#128465; Purge All Test Data'; }
  }
}

// Expose Phase 1A.1.1/1A.1.2 functions on window for inline onclick handlers
(function() {
  try {
    ['quotesResetNumEditState','quotesToggleNumEdit','quotesPrefillNextJobNumber',
     'refreshTestDataStatus','seedTestData','purgeTestData'
    ].forEach(function(name){
      try { if (typeof eval(name) === 'function') window[name] = eval(name); } catch(e) {}
    });
    console.log('[KVM] Phase 1A.1.1 + 1A.1.2 functions exposed');
  } catch(e) { console.error('[KVM] Phase 1A.1.1+1A.1.2 exposure failed:', e); }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ PHASE 1A.2a — CREATE FROM QUOTE CHOOSER + QUICK JOBS MODULE ═════════════
// ═══════════════════════════════════════════════════════════════════════════════

let _cfqJobType = null;

function cfqOpen() {
  _cfqJobType = null;
  const matRow = $('cfq-materials-row');
  if (matRow) matRow.style.display = 'none';
  const btn = $('cfq-confirm-btn');
  if (btn) btn.disabled = true;
  // Reset card styles
  ['cfq-project','cfq-quick_job'].forEach(id => {
    const el = $(id);
    if (el) { el.style.border = '2px solid var(--border)'; el.style.background = 'var(--bg-surface)'; }
  });
  openModal('createFromQuoteModal');
}

function cfqPick(type) {
  _cfqJobType = type;
  // Highlight picked card, dim other
  ['cfq-project','cfq-quick_job'].forEach(id => {
    const el = $(id); if (!el) return;
    if (id === 'cfq-' + type) {
      el.style.border = '2px solid var(--amber)';
      el.style.background = 'var(--bg-card)';
    } else {
      el.style.border = '2px solid var(--border)';
      el.style.background = 'var(--bg-surface)';
      el.style.opacity = '0.6';
    }
  });
  // Show material status row for quick jobs (more relevant for quick scheduling)
  const matRow = $('cfq-materials-row');
  if (matRow) matRow.style.display = 'block';
  const matSel = $('cfq-material-status');
  if (matSel) matSel.value = (type === 'quick_job' ? 'from_stock' : 'ordered');
  const btn = $('cfq-confirm-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Create ' + (type === 'quick_job' ? 'Quick Job' : 'Project'); }
}

async function cfqConfirm() {
  if (!_cfqJobType) { showToast('Pick Project or Quick Job first.','error'); return; }
  if (!quotesCurrentId) { showToast('Quote not loaded.','error'); closeModal('createFromQuoteModal'); return; }
  const matStatus = ($('cfq-material-status') && $('cfq-material-status').value) || 'ordered';
  const btn = $('cfq-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
  try {
    const res = await api('POST', '/api/quotes/' + quotesCurrentId + '/create-project', {
      job_type: _cfqJobType,
      material_status: matStatus
    });
    closeModal('createFromQuoteModal');
    showToast((_cfqJobType === 'quick_job' ? 'Quick Job' : 'Project') + ' created!', 'success');
    setTimeout(() => {
      if (res.job_type === 'quick_job') {
        showPage('quickJobs', null);
        if (typeof openQuickJobDetail === 'function') openQuickJobDetail(res.project_id);
      } else {
        showPage('projects', null);
        if (typeof openProjectDetail === 'function') openProjectDetail(res.project_id);
      }
    }, 300);
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
  }
}

// ─── QUICK JOBS LIST ─────────────────────────────────────────────────────────
let _qjAll = [];

async function loadQuickJobs() {
  const body = $('qj-table-body');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint);font-size:13px">Loading...</div>';
  try {
    _qjAll = await api('GET', '/api/projects?job_type=quick_job');
    qjRenderList();
  } catch(e) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger);font-size:13px">Error: ' + e.message + '</div>';
  }
}

function qjFilter() { qjRenderList(); }

function qjMaterialBadge(ms) {
  const map = {
    from_stock: {label:'From Stock',color:'var(--green)'},
    ordered:    {label:'Ordered',   color:'var(--amber)'},
    partial:    {label:'Partial',   color:'var(--amber)'},
    received:   {label:'Received',  color:'var(--green)'}
  };
  const m = map[ms] || {label:ms||'—',color:'var(--text-muted)'};
  return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:${m.color}22;color:${m.color};border:1px solid ${m.color}44;text-transform:uppercase;letter-spacing:.04em">${m.label}</span>`;
}

function qjStatusBadge(s) {
  const map = {
    awarded:     {label:'Awarded',    color:'#2980b9'},
    scheduled:   {label:'Scheduled',  color:'#8e44ad'},
    in_progress: {label:'In Progress',color:'var(--amber)'},
    complete:    {label:'Complete',   color:'var(--green)'}
  };
  const m = map[s] || {label:s||'—',color:'var(--text-muted)'};
  return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${m.color}22;color:${m.color};border:1px solid ${m.color}44;text-transform:uppercase;letter-spacing:.04em">${m.label}</span>`;
}

function qjBillBadge(bs) {
  if (!bs || bs === 'not_ready') return '';
  const map = {
    ready_to_bill:{label:'Ready to Bill',color:'var(--amber)'},
    billed:       {label:'Billed',        color:'#2980b9'},
    paid:         {label:'Paid',          color:'var(--green)'}
  };
  const m = map[bs]; if (!m) return '';
  return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:${m.color}22;color:${m.color};border:1px solid ${m.color}44">${m.label}</span>`;
}

function qjRenderList() {
  const body = $('qj-table-body');
  const countEl = $('qj-count');
  const search = ($('qj-search') && $('qj-search').value.toLowerCase()) || '';
  const statusF = ($('qj-status-filter') && $('qj-status-filter').value) || '';
  const matF = ($('qj-mat-filter') && $('qj-mat-filter').value) || '';
  let filtered = _qjAll;
  if (search) filtered = filtered.filter(q => (q.project_name||'').toLowerCase().includes(search) || (q.customer_name||'').toLowerCase().includes(search) || (q.job_number||'').toLowerCase().includes(search));
  if (statusF) filtered = filtered.filter(q => q.status === statusF);
  if (matF) filtered = filtered.filter(q => q.material_status === matF);
  if (countEl) countEl.textContent = filtered.length + ' job' + (filtered.length !== 1 ? 's' : '');
  if (!filtered.length) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint);font-size:13px">' + (_qjAll.length ? 'No quick jobs match your filter.' : 'No quick jobs yet. Create one by marking a quote as Accepted and clicking "Create from Awarded Quote".') + '</div>';
    return;
  }
  body.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Job #</th><th>Customer</th><th>Description</th><th>Status</th><th>Material</th><th>Bill</th><th>Value</th></tr></thead>
    <tbody>${filtered.map(q => `
      <tr style="cursor:pointer" onclick="openQuickJobDetail(${q.id})">
        <td style="font-family:monospace;font-size:12px;color:var(--amber)">${q.job_number||'—'}</td>
        <td><strong>${escapeHtml(q.customer_name||'—')}</strong></td>
        <td style="font-size:12px;color:var(--text-muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(q.project_name||'—')}</td>
        <td>${qjStatusBadge(q.status)}</td>
        <td>${qjMaterialBadge(q.material_status)}</td>
        <td>${qjBillBadge(q.bill_status)}</td>
        <td style="font-weight:600;text-align:right">${q.contract_value ? '$'+parseFloat(q.contract_value).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:2}) : '—'}</td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

// ─── QUICK JOB DETAIL ────────────────────────────────────────────────────────
let _qjCurrent = null;

async function openQuickJobDetail(id) {
  showPage('quickJobDetail', null);
  loadQuickJobDetail(id);
}

async function loadQuickJobDetail(id) {
  id = id || (_qjCurrent && _qjCurrent.id);
  if (!id) return;
  const body = $('qjDetailContent');
  if (body) body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint)">Loading...</div>';
  try {
    const q = await api('GET', '/api/projects/' + id);
    _qjCurrent = q;
    qjRenderDetail(q);
  } catch(e) {
    if (body) body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--danger)">Error: ' + e.message + '</div>';
  }
}

function fmtMoneyQJ(n) {
  const num = parseFloat(n);
  if (!num || isNaN(num)) return '$0';
  return '$' + num.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2});
}

function qjRenderDetail(q) {
  // Header fields
  if ($('qjDetailName')) $('qjDetailName').textContent = q.project_name || 'Quick Job';
  if ($('qjDetailStatus')) $('qjDetailStatus').innerHTML = qjStatusBadge(q.status);
  if ($('qjDetailMaterial')) $('qjDetailMaterial').innerHTML = qjMaterialBadge(q.material_status);
  if ($('qjDetailBill')) $('qjDetailBill').innerHTML = qjBillBadge(q.bill_status);
  if ($('qjDetailJob')) $('qjDetailJob').textContent = q.job_number ? '#' + q.job_number : '';
  if ($('qjDetailCustomer')) $('qjDetailCustomer').textContent = q.customer_name || '';
  if ($('qjDetailValue')) $('qjDetailValue').textContent = q.contract_value ? fmtMoneyQJ(q.contract_value) : '';

  // Compute cost totals by category
  const costs = q.costs || [];
  const costByCat = { materials: 0, labor: 0, equipment: 0, subs: 0 };
  costs.forEach(c => { if (costByCat[c.category] !== undefined) costByCat[c.category] += parseFloat(c.total_cost)||0; });
  const totalCost = costByCat.materials + costByCat.labor + costByCat.equipment + costByCat.subs;
  const contractVal = parseFloat(q.contract_value) || 0;
  const margin = contractVal - totalCost;
  const marginPct = contractVal ? (margin / contractVal * 100).toFixed(1) : '0';
  const marginColor = margin < 0 ? 'var(--danger)' : margin / Math.max(contractVal,1) < 0.15 ? 'var(--amber)' : 'var(--green)';

  const hours = q.hours || [];
  const totalHours = hours.reduce((s,h) => s + (parseFloat(h.hours)||0), 0);

  // Quote link
  const quoteLink = q.quote_id ? `<a href="#" onclick="openQuoteFromQJ(${q.quote_id});return false;" style="color:var(--amber);text-decoration:none;border-bottom:1px dashed var(--amber)">View source quote #${escapeHtml(q.quote_number||q.quote_id)}</a>` : '<span style="color:var(--text-faint)">No source quote</span>';

  const body = $('qjDetailContent');
  body.innerHTML = `
    <!-- OVERVIEW -->
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header"><span class="card-title">Overview</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Scope</div>
          <div style="font-size:13px;color:var(--text);white-space:pre-wrap">${escapeHtml(q.scope_brief||'(no scope provided)')}</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:1rem;margin-bottom:4px">Notes</div>
          <div style="font-size:13px;color:var(--text-muted);white-space:pre-wrap">${escapeHtml(q.notes||'(no notes)')}</div>
        </div>
        <div>
          <div class="info-row"><span class="info-label">Customer</span><span class="info-val">${escapeHtml(q.customer_name||'—')}</span></div>
          <div class="info-row"><span class="info-label">Location</span><span class="info-val">${escapeHtml(q.location||'—')}</span></div>
          <div class="info-row"><span class="info-label">Contract Value</span><span class="info-val" style="color:var(--amber);font-weight:600">${fmtMoneyQJ(q.contract_value)}</span></div>
          <div class="info-row"><span class="info-label">Revenue Dept</span><span class="info-val">${escapeHtml(q.revenue_department||'—')}</span></div>
          <div class="info-row"><span class="info-label">Invoice #</span><span class="info-val">${escapeHtml(q.invoice_number||'—')}</span></div>
          <div class="info-row"><span class="info-label">Source</span><span class="info-val">${quoteLink}</span></div>
        </div>
      </div>
    </div>

    <!-- JOB COSTING -->
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header">
        <span class="card-title">💰 Job Costing</span>
        <button class="btn btn-primary btn-sm" onclick="openAddQuickJobCost()">+ Add Cost</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:1rem">
        <div style="padding:10px;background:var(--bg-surface);border-radius:var(--radius-sm);text-align:center">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Materials</div>
          <div style="font-size:18px;font-weight:600;color:var(--text)">${fmtMoneyQJ(costByCat.materials)}</div>
        </div>
        <div style="padding:10px;background:var(--bg-surface);border-radius:var(--radius-sm);text-align:center">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Labor</div>
          <div style="font-size:18px;font-weight:600;color:var(--text)">${fmtMoneyQJ(costByCat.labor)}</div>
        </div>
        <div style="padding:10px;background:var(--bg-surface);border-radius:var(--radius-sm);text-align:center">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Equipment</div>
          <div style="font-size:18px;font-weight:600;color:var(--text)">${fmtMoneyQJ(costByCat.equipment)}</div>
        </div>
        <div style="padding:10px;background:var(--bg-surface);border-radius:var(--radius-sm);text-align:center">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Subs</div>
          <div style="font-size:18px;font-weight:600;color:var(--text)">${fmtMoneyQJ(costByCat.subs)}</div>
        </div>
      </div>
      <div style="padding:12px;background:var(--bg-surface);border-radius:var(--radius-sm);margin-bottom:1rem;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center">
        <div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Contract</div><div style="font-size:16px;font-weight:700;color:var(--amber)">${fmtMoneyQJ(contractVal)}</div></div>
        <div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Total Cost</div><div style="font-size:16px;font-weight:700;color:var(--text)">${fmtMoneyQJ(totalCost)}</div></div>
        <div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Margin</div><div style="font-size:16px;font-weight:700;color:${marginColor}">${fmtMoneyQJ(margin)} <span style="font-size:11px;opacity:.7">(${marginPct}%)</span></div></div>
      </div>
      ${costs.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Category</th><th>Vendor</th><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th><th>Invoice</th><th></th></tr></thead>
        <tbody>${costs.map(c => `<tr>
          <td><span style="font-size:10px;text-transform:uppercase;color:var(--text-muted)">${escapeHtml(c.category||'—')}</span></td>
          <td style="font-size:12px">${escapeHtml(c.vendor||'—')}</td>
          <td style="font-size:12px">${escapeHtml(c.description||'—')}</td>
          <td style="font-size:12px;text-align:right">${c.quantity||'—'}</td>
          <td style="font-size:12px;text-align:right">${fmtMoneyQJ(c.unit_cost)}</td>
          <td style="font-weight:600;text-align:right">${fmtMoneyQJ(c.total_cost)}</td>
          <td style="font-size:11px;color:var(--text-muted)">${escapeHtml(c.invoice_number||'')}</td>
          <td><button class="btn btn-danger btn-sm" onclick="deleteQuickJobCost(${c.id})">✕</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:13px">No costs logged yet.</div>'}
    </div>

    <!-- HOURS -->
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header">
        <span class="card-title">⏱ Hours Logged <span style="font-size:12px;color:var(--text-muted);font-weight:400">(${totalHours.toFixed(2)} hrs total)</span></span>
        <button class="btn btn-primary btn-sm" onclick="openAddQuickJobHours()">+ Log Hours</button>
      </div>
      ${hours.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Technician</th><th>Date</th><th>Hours</th><th>Notes</th><th>Source</th><th></th></tr></thead>
        <tbody>${hours.map(h => `<tr>
          <td><strong>${escapeHtml(h.user_name||'—')}</strong></td>
          <td style="font-size:12px">${h.work_date ? fmtDate(h.work_date) : '—'}</td>
          <td style="font-weight:600;text-align:right">${parseFloat(h.hours||0).toFixed(2)}</td>
          <td style="font-size:12px;color:var(--text-muted)">${escapeHtml(h.notes||'')}</td>
          <td><span style="font-size:10px;padding:2px 6px;border-radius:3px;background:${h.entry_type==='auto'?'var(--amber)22':'var(--bg-surface)'};color:${h.entry_type==='auto'?'var(--amber)':'var(--text-muted)'};text-transform:uppercase">${h.entry_type||'manual'}</span></td>
          <td><button class="btn btn-danger btn-sm" onclick="deleteQuickJobHours(${h.id})">✕</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:13px">No hours logged yet.</div>'}
    </div>

    <!-- MATERIAL + BILL STATUS TOGGLES -->
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header"><span class="card-title">Status Controls</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div>
          <label class="ql">Material Status</label>
          <select id="qj-quick-mat" onchange="qjQuickPatch('material_status',this.value)">
            <option value="from_stock" ${q.material_status==='from_stock'?'selected':''}>🟢 From Stock</option>
            <option value="ordered" ${q.material_status==='ordered'?'selected':''}>🟡 Ordered</option>
            <option value="partial" ${q.material_status==='partial'?'selected':''}>🟡 Partial</option>
            <option value="received" ${q.material_status==='received'?'selected':''}>🟢 Received</option>
          </select>
        </div>
        <div>
          <label class="ql">Bill Status</label>
          <select id="qj-quick-bill" onchange="qjQuickPatch('bill_status',this.value)">
            <option value="not_ready" ${q.bill_status==='not_ready'?'selected':''}>Not Ready</option>
            <option value="ready_to_bill" ${q.bill_status==='ready_to_bill'?'selected':''}>Ready to Bill</option>
            <option value="billed" ${q.bill_status==='billed'?'selected':''}>Billed</option>
            <option value="paid" ${q.bill_status==='paid'?'selected':''}>Paid</option>
          </select>
        </div>
      </div>
    </div>
  `;
}

function openQuoteFromQJ(quoteId) {
  showPage('sales', null);
  setTimeout(() => { if (typeof quotesOpenEdit === 'function') quotesOpenEdit(quoteId); }, 200);
}

async function qjQuickPatch(field, value) {
  if (!_qjCurrent || !_qjCurrent.id) return;
  try {
    const body = {}; body[field] = value;
    await api('PATCH', '/api/projects/' + _qjCurrent.id + '/status', body);
    showToast('Updated.', 'success');
    loadQuickJobDetail(_qjCurrent.id);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

// ─── QUICK JOB: EDIT MODAL ───────────────────────────────────────────────────
function openEditQuickJob() {
  if (!_qjCurrent) return;
  const q = _qjCurrent;
  if ($('qjEditModalTitle')) $('qjEditModalTitle').textContent = 'Edit ' + (q.job_number ? '#' + q.job_number : 'Quick Job');
  if ($('qj-edit-name')) $('qj-edit-name').value = q.project_name || '';
  if ($('qj-edit-customer')) $('qj-edit-customer').value = q.customer_name || '';
  if ($('qj-edit-contract')) $('qj-edit-contract').value = q.contract_value || '';
  if ($('qj-edit-scope')) $('qj-edit-scope').value = q.scope_brief || '';
  if ($('qj-edit-status')) $('qj-edit-status').value = q.status || 'awarded';
  if ($('qj-edit-revdept')) $('qj-edit-revdept').value = q.revenue_department || '';
  if ($('qj-edit-material')) $('qj-edit-material').value = q.material_status || 'ordered';
  if ($('qj-edit-bill')) $('qj-edit-bill').value = q.bill_status || 'not_ready';
  if ($('qj-edit-invoice')) $('qj-edit-invoice').value = q.invoice_number || '';
  if ($('qj-edit-notes')) $('qj-edit-notes').value = q.notes || '';
  openModal('qjEditModal');
}

async function saveQuickJob() {
  if (!_qjCurrent) return;
  const payload = {
    project_name: $('qj-edit-name').value.trim(),
    customer_id: _qjCurrent.customer_id || 0,
    customer_name: _qjCurrent.customer_name || '',
    site_id: _qjCurrent.site_id || 0,
    location: _qjCurrent.location || '',
    quote_id: _qjCurrent.quote_id || 0,
    quote_number: _qjCurrent.quote_number || '',
    job_number: _qjCurrent.job_number || '',
    contract_value: $('qj-edit-contract').value.trim(),
    billing_type: _qjCurrent.billing_type || 'aftermarket',
    scope_brief: $('qj-edit-scope').value.trim(),
    status: $('qj-edit-status').value,
    start_date: _qjCurrent.start_date || '',
    target_end_date: _qjCurrent.target_end_date || '',
    actual_end_date: _qjCurrent.actual_end_date || '',
    foreman_id: _qjCurrent.foreman_id || 0,
    foreman_name: _qjCurrent.foreman_name || '',
    assigned_techs: _qjCurrent.assigned_techs || [],
    notes: $('qj-edit-notes').value.trim(),
    material_status: $('qj-edit-material').value,
    bill_status: $('qj-edit-bill').value,
    invoice_number: $('qj-edit-invoice').value.trim()
  };
  try {
    await api('PUT', '/api/projects/' + _qjCurrent.id, payload);
    // Revenue dept is not in the standard PUT payload — patch it
    if ($('qj-edit-revdept').value !== (_qjCurrent.revenue_department||'')) {
      // Note: revenue_department isn't handled by PUT currently — would need a separate PATCH or extension
      // For now, saved fields are in the PUT
    }
    closeModal('qjEditModal');
    showToast('Saved!', 'success');
    loadQuickJobDetail(_qjCurrent.id);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function deleteQuickJob() {
  if (!_qjCurrent) return;
  if (!confirm('Delete this Quick Job? This cannot be undone — all costs, hours, and notes attached will also be removed.')) return;
  try {
    await api('DELETE', '/api/projects/' + _qjCurrent.id);
    showToast('Deleted.', 'success');
    showPage('quickJobs', null);
    loadQuickJobs();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

// ─── QUICK JOB: COST MODAL ───────────────────────────────────────────────────
function openAddQuickJobCost() {
  if (!_qjCurrent) return;
  if ($('qj-cost-cat')) $('qj-cost-cat').value = 'materials';
  ['qj-cost-vendor','qj-cost-desc','qj-cost-invoice','qj-cost-invdate'].forEach(id => { const e=$(id); if(e) e.value=''; });
  if ($('qj-cost-qty')) $('qj-cost-qty').value = '1';
  if ($('qj-cost-unit')) $('qj-cost-unit').value = '';
  if ($('qj-cost-total')) $('qj-cost-total').value = '';
  openModal('qjCostModal');
}

function qjCostCalc() {
  const qty = parseFloat($('qj-cost-qty').value) || 0;
  const unit = parseFloat($('qj-cost-unit').value) || 0;
  const total = qty * unit;
  if ($('qj-cost-total')) $('qj-cost-total').value = total.toFixed(2);
}

async function saveQuickJobCost() {
  if (!_qjCurrent) return;
  const qty = parseFloat($('qj-cost-qty').value) || 1;
  const unit = parseFloat($('qj-cost-unit').value) || 0;
  const total = qty * unit;
  const payload = {
    category: $('qj-cost-cat').value,
    vendor: $('qj-cost-vendor').value.trim(),
    description: $('qj-cost-desc').value.trim(),
    quantity: qty,
    unit_cost: unit,
    total_cost: total,
    invoice_number: $('qj-cost-invoice').value.trim(),
    invoice_date: $('qj-cost-invdate').value
  };
  if (!payload.description) { showToast('Description is required.', 'error'); return; }
  try {
    await api('POST', '/api/projects/' + _qjCurrent.id + '/costs', payload);
    closeModal('qjCostModal');
    showToast('Cost added.', 'success');
    loadQuickJobDetail(_qjCurrent.id);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function deleteQuickJobCost(costId) {
  if (!_qjCurrent) return;
  if (!confirm('Delete this cost entry?')) return;
  try {
    await api('DELETE', '/api/projects/' + _qjCurrent.id + '/costs/' + costId);
    showToast('Deleted.', 'success');
    loadQuickJobDetail(_qjCurrent.id);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

// ─── QUICK JOB: HOURS MODAL ──────────────────────────────────────────────────
async function openAddQuickJobHours() {
  if (!_qjCurrent) return;
  // Populate technician dropdown
  try {
    const users = await api('GET', '/api/users');
    const sel = $('qj-hours-tech');
    if (sel) {
      sel.innerHTML = '<option value="">— pick technician —</option>' +
        (users||[]).filter(u => u.is_active !== 0).map(u => `<option value="${u.id}" data-name="${escapeHtml((u.first_name||'')+' '+(u.last_name||''))}">${escapeHtml((u.first_name||'')+' '+(u.last_name||''))}</option>`).join('');
    }
  } catch(e){}
  if ($('qj-hours-date')) $('qj-hours-date').value = new Date().toISOString().split('T')[0];
  if ($('qj-hours-qty')) $('qj-hours-qty').value = '';
  if ($('qj-hours-notes')) $('qj-hours-notes').value = '';
  openModal('qjHoursModal');
}

async function saveQuickJobHours() {
  if (!_qjCurrent) return;
  const techSel = $('qj-hours-tech');
  const userId = parseInt(techSel.value) || 0;
  if (!userId) { showToast('Pick a technician.', 'error'); return; }
  const opt = techSel.selectedOptions[0];
  const userName = opt ? opt.getAttribute('data-name') : '';
  const payload = {
    user_id: userId,
    user_name: userName,
    work_date: $('qj-hours-date').value,
    hours: parseFloat($('qj-hours-qty').value) || 0,
    notes: $('qj-hours-notes').value.trim(),
    entry_type: 'manual',
    phase_id: 0
  };
  if (!payload.work_date || !payload.hours) { showToast('Date and hours are required.', 'error'); return; }
  try {
    await api('POST', '/api/projects/' + _qjCurrent.id + '/hours', payload);
    closeModal('qjHoursModal');
    showToast('Hours logged.', 'success');
    loadQuickJobDetail(_qjCurrent.id);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function deleteQuickJobHours(hId) {
  if (!_qjCurrent) return;
  if (!confirm('Delete this hours entry?')) return;
  try {
    await api('DELETE', '/api/projects/' + _qjCurrent.id + '/hours/' + hId);
    showToast('Deleted.', 'success');
    loadQuickJobDetail(_qjCurrent.id);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

// Expose Phase 1A.2a functions on window
(function() {
  try {
    ['cfqOpen','cfqPick','cfqConfirm',
     'loadQuickJobs','qjFilter','qjRenderList','openQuickJobDetail','loadQuickJobDetail','qjRenderDetail',
     'openQuoteFromQJ','qjQuickPatch',
     'openEditQuickJob','saveQuickJob','deleteQuickJob',
     'openAddQuickJobCost','qjCostCalc','saveQuickJobCost','deleteQuickJobCost',
     'openAddQuickJobHours','saveQuickJobHours','deleteQuickJobHours'
    ].forEach(function(name){
      try { if (typeof eval(name) === 'function') window[name] = eval(name); } catch(e) {}
    });
    console.log('[KVM] Phase 1A.2a functions exposed');
  } catch(e) { console.error('[KVM] Phase 1A.2a exposure failed:', e); }
})();
