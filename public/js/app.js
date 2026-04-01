/* ═══ KVM DOOR SYSTEMS PORTAL v3 ═══ */
let currentUser = null;
let oncallFilter = 'current';
let adminPtoFilter = 'pending';
let allUsers = [], allBlackouts = [], rotationData = null;

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
    ['btnNewAnn','btnNewNews','btnNewOncall','btnAutoSchedule','btnLoadSchedule'].forEach(id=>{ const el=$(id); if(el) el.style.display='inline-flex'; });
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
  const map={dashboard:renderDashboard,announcements:renderAnnouncements,news:renderNews,oncall:renderOncall,directory:renderDirectory,pto:renderPto,adminUsers:renderAdminUsers,adminPto:renderAdminPto,adminBlackout:renderBlackouts,adminRotation:renderRotation,adminSettings:loadSettings};
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
    await api('POST','/api/users',{username,password,first_name,last_name,role:$('addRole').value,department:$('addDept').value,oncall_dept:$('addOncallDept').value,oncall_role:$('addOncallRole').value,phone:$('addPhone').value,email:$('addEmail').value,is_admin:$('addIsAdmin').value==='true',pto_total:parseInt($('addPtoTotal').value)||10,pto_left:parseInt($('addPtoLeft').value)||10,hire_date:$('addHireDate').value||'',avatar_color:avatarBg(first_name+last_name)});
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
  try { const s=await api('GET','/api/settings'); ['smtp_host','smtp_port','smtp_user','smtp_from_name'].forEach(k=>{ if(s[k]&&$(k)) $(k).value=s[k]; }); } catch(e){}
}
async function saveSmtpSettings() {
  try { await api('POST','/api/settings',{smtp_host:$('smtpHost').value,smtp_port:$('smtpPort').value,smtp_user:$('smtpUser').value,smtp_pass:$('smtpPass').value,smtp_from_name:$('smtpFromName').value}); showToast('Email settings saved!','success'); } catch(e){showToast(e.message,'error');}
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    currentUser=await api('GET','/api/me');
    $('loginScreen').style.display='none'; $('mainApp').style.display='block';
    setupUI(); await loadBlackouts();
    showPage('dashboard',document.querySelector('.nav-item[data-page="dashboard"]'));
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

  openModal('editUserModal');
}

async function saveEditUser() {
  const id = $('editUserId').value;
  const first_name = $('editFirst').value.trim();
  const username   = $('editUsername').value.trim();
  if (!first_name || !username) return showToast('First name and username are required.', 'error');

  try {
    await api('PUT', '/api/users/' + id, {
      first_name,
      last_name:    $('editLast').value.trim(),
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

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW    = ['Su','Mo','Tu','We','Th','Fr','Sa'];

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
  const m1 = calViewMonth;
  const y1 = calViewYear;
  let m2 = m1 + 1, y2 = y1;
  if (m2 > 11) { m2 = 0; y2++; }

  $('ptoCalLabel1').textContent = MONTHS[m1] + ' ' + y1;
  $('ptoCalLabel2').textContent = MONTHS[m2] + ' ' + y2;

  $('ptoCalGrid1').innerHTML = buildCalMonth(y1, m1);
  $('ptoCalGrid2').innerHTML = buildCalMonth(y2, m2);

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
  }, 30);
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
