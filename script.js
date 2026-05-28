/* ============================================================
   ANTERA MECHANIC CALCULATOR — script.js
   Supabase backend · Multi-mechanic · Admin dashboard
   ============================================================ */
'use strict';

/* ── Config ─────────────────────────────────────────────── */
const SUPABASE_URL = 'https://mgvmzssfpxoizjkzncmo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ndm16c3NmcHhvaXpqa3puY21vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDIzNzUsImV4cCI6MjA5NTQ3ODM3NX0._Vf3Be1ghASBFjihz8otAWnOKnEBc6c_TQMn6NYMD3A';

const ADMIN_USER = 'antera';
const ADMIN_PASS = 'antera';

const SERVICES = [
  'Repair Kit','Cleaning Kit','Performance','Respray',
  'Tyre Smoke Kit','Cosmetic','Lighting','Extras Kit','Vehicle Wheel'
];

/* ── Supabase helper ─────────────────────────────────────── */
async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ── DB bootstrap: create tables via RPC if missing ────────
   Tables needed:
   - mechanics(id serial PK, username text UNIQUE, password text, created_at timestamptz)
   - usage_logs(id serial PK, username text, date text, service text, qty int, created_at timestamptz)
   We use upsert patterns so no migrations needed manually.
──────────────────────────────────────────────────────────── */

/* ── State ───────────────────────────────────────────────── */
let currentUser = null; // { username, isAdmin }
const calcState  = {};  // { serviceName: { qty, price } }

/* ── Audio ───────────────────────────────────────────────── */
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
  }
  return audioCtx;
}
function beep(freq=880, dur=0.09, vol=0.1) {
  const ctx = getAudio(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.type='sine'; o.frequency.value=freq;
  o.frequency.exponentialRampToValueAtTime(freq*.6, ctx.currentTime+dur);
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime+dur);
  o.start(); o.stop(ctx.currentTime+dur);
}

/* ── Utilities ───────────────────────────────────────────── */
function fmt(n) { return n===0?'$0':'$'+n.toLocaleString('en-US'); }
function today() { return new Date().toISOString().slice(0,10); }
function nowISO() { return new Date().toISOString(); }
function animBump(el, txt) {
  el.classList.remove('bump'); void el.offsetWidth;
  el.textContent=txt; el.classList.add('bump');
  setTimeout(()=>el.classList.remove('bump'),300);
}
function show(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id)  { document.getElementById(id)?.classList.add('hidden'); }
function el(id)    { return document.getElementById(id); }

/* ── Toggle password visibility ─────────────────────────── */
window.togglePw = function(inputId, btn) {
  const inp = el(inputId);
  inp.type = inp.type==='password' ? 'text' : 'password';
  btn.style.opacity = inp.type==='text' ? '1' : '';
};

/* ══════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════ */
window.handleLogin = async function() {
  const username = el('loginUsername').value.trim().toLowerCase();
  const password = el('loginPassword').value;
  const errEl    = el('loginError');
  errEl.textContent = '';

  if (!username || !password) {
    errEl.textContent = 'Please enter username and password.'; return;
  }

  // Admin shortcut
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    currentUser = { username: 'antera', isAdmin: true };
    enterAdmin();
    return;
  }

  // Check mechanics table
  try {
    const rows = await sb('GET', `mechanics?username=eq.${encodeURIComponent(username)}&select=username,password`);
    if (!rows || rows.length === 0) {
      errEl.textContent = 'Username not found.'; return;
    }
    if (rows[0].password !== password) {
      errEl.textContent = 'Incorrect password.'; return;
    }
    currentUser = { username: rows[0].username, isAdmin: false };
    enterApp();
  } catch(e) {
    errEl.textContent = 'Connection error. Try again.';
    console.error(e);
  }
};

window.handleLogout = function() {
  currentUser = null;
  resetCalc();
  hide('app'); hide('adminDashboard');
  show('authScreen');
  el('loginUsername').value='';
  el('loginPassword').value='';
  el('loginError').textContent='';
};

function enterApp() {
  hide('authScreen');
  const appEl = el('app');
  appEl.classList.remove('hidden');
  setTimeout(()=>appEl.classList.add('visible'),30);
  el('topbarName').textContent = currentUser.username;
  el('topbarAvatar').textContent = currentUser.username.charAt(0).toUpperCase();
}

function enterAdmin() {
  hide('authScreen');
  const adEl = el('adminDashboard');
  adEl.classList.remove('hidden');
  setTimeout(()=>adEl.classList.add('visible'),30);
  updateAdminDate();
  loadAdminData();
}

/* ══════════════════════════════════════════════════════════
   CALCULATOR
══════════════════════════════════════════════════════════ */
function initCalc() {
  document.querySelectorAll('.service-row').forEach(row => {
    const name  = row.dataset.service;
    const price = parseInt(row.dataset.price, 10);
    calcState[name] = { qty: 0, price };

    const minusBtn   = row.querySelector('.minus-btn');
    const plusBtn    = row.querySelector('.plus-btn');
    const qtyEl      = row.querySelector('.qty-input');
    const subtotalEl = row.querySelector('.service-subtotal');

    plusBtn.addEventListener('click', () => {
      if (name==='Performance' && calcState[name].qty>=6) return;
      calcState[name].qty++;
      qtyEl.value = calcState[name].qty;
      updateRow(row, name, qtyEl, subtotalEl);
      updateTotal();
      beep(880);
    });
    minusBtn.addEventListener('click', () => {
      if (calcState[name].qty===0) return;
      calcState[name].qty--;
      qtyEl.value = calcState[name].qty;
      updateRow(row, name, qtyEl, subtotalEl);
      updateTotal();
      beep(660);
    });

    // Type directly into the box
    qtyEl.addEventListener('input', () => {
      let val = parseInt(qtyEl.value, 10);
      if (isNaN(val) || val < 0) val = 0;
      if (name==='Performance' && val > 6) val = 6;
      if (val > 999) val = 999;
      calcState[name].qty = val;
      qtyEl.value = val;
      updateRow(row, name, qtyEl, subtotalEl);
      updateTotal();
    });

    // Select all on focus for easy replacement
    qtyEl.addEventListener('focus', () => qtyEl.select());
  });

  el('resetBtn').addEventListener('click', () => { resetCalc(); beep(440,.18,.08); beep(330,.18,.08); });
  el('copyBtn').addEventListener('click', copySummary);
}

function perfSubtotal(qty) {
  if (qty===5) return 830000;
  if (qty===6) return 930000;
  return qty * 166000;
}

function updateRow(row, name, qtyEl, subtotalEl) {
  const { qty, price } = calcState[name];
  qtyEl.value = qty;
  const sub = name==='Performance' ? perfSubtotal(qty) : qty*price;
  subtotalEl.textContent = fmt(sub);
  row.classList.toggle('active', qty>0);
  if (name==='Performance') {
    const pl = row.querySelector('.service-price');
    if (qty===5) pl.textContent='⚡ Bundle x5 = $830,000';
    else if (qty===6) pl.textContent='⚡ Bundle x6 = $930,000';
    else pl.textContent='$166,000 each';
  }
}

function calcTotal() {
  let total=0;
  Object.entries(calcState).forEach(([name,{qty,price}])=>{
    total += name==='Performance' ? perfSubtotal(qty) : qty*price;
  });
  return total;
}

function updateTotal() {
  const total   = calcTotal();
  const totalEl = el('totalAmount');
  const subEl   = el('totalSubtext');
  const stickyEl= el('stickyTotal');

  animBump(totalEl, fmt(total));
  stickyEl.textContent = fmt(total);

  let count=0, lines=0;
  Object.entries(calcState).forEach(([,{qty}])=>{ count+=qty; if(qty>0)lines++; });

  if (count===0) { subEl.textContent='No services selected'; return; }
  if (lines===1) {
    const [name,{qty}]=Object.entries(calcState).find(([,v])=>v.qty>0);
    subEl.textContent=`${qty}x ${name}`;
  } else {
    subEl.textContent=`${count} items across ${lines} services`;
  }
}

function resetCalc() {
  Object.keys(calcState).forEach(name=>{ calcState[name].qty=0; });
  document.querySelectorAll('.service-row').forEach(row=>{
    row.querySelector('.qty-input').textContent='0';
    row.querySelector('.service-subtotal').textContent='$0';
    row.classList.remove('active');
    if (row.dataset.service==='Performance') row.querySelector('.service-price').textContent='$166,000 each';
  });
  updateTotal();
}

/* ── Log usage to Supabase ───────────────────────────────── */
async function logUsage() {
  const dateStr = today();
  const entries = [];
  Object.entries(calcState).forEach(([service,{qty}])=>{
    if (qty>0) entries.push({ username: currentUser.username, date: dateStr, service, qty, created_at: nowISO() });
  });
  if (entries.length===0) return;
  try {
    await sb('POST','usage_logs', entries);
  } catch(e) { console.warn('Log failed:', e); }
}

/* ── Copy summary ────────────────────────────────────────── */
function copySummary() {
  const lines=['═══════════════════════════════','   🔧 ANTERA MECHANIC — QUOTE','═══════════════════════════════'];
  let total=0, has=false;
  Object.entries(calcState).forEach(([name,{qty,price}])=>{
    if (qty>0) {
      has=true;
      const sub=name==='Performance'?perfSubtotal(qty):qty*price;
      total+=sub;
      const deal=name==='Performance'&&(qty===5||qty===6)?' ⚡bundle':'';
      lines.push(`  ${name.padEnd(18)} x${qty}  →  ${fmt(sub)}${deal}`);
    }
  });
  if (!has) lines.push('  (no services selected)');
  lines.push('───────────────────────────────',`  TOTAL: ${fmt(total)}`,'═══════════════════════════════');
  const txt=lines.join('\n');
  navigator.clipboard.writeText(txt).then(showToast).catch(()=>{
    const ta=document.createElement('textarea');
    ta.value=txt; ta.style.cssText='position:fixed;opacity:0;';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); showToast();
  });
  logUsage();
}

let toastTimer=null;
function showToast() {
  const t=el('toast'); t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),2400);
}

/* ══════════════════════════════════════════════════════════
   ADMIN DASHBOARD
══════════════════════════════════════════════════════════ */
function updateAdminDate() {
  const now=new Date();
  el('adminDate').textContent=now.toLocaleDateString('en-GB',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
}

window.switchAdminTab = function(tab, btn) {
  document.querySelectorAll('.admin-tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  if (tab==='usage')     { show('tabUsage'); hide('tabMechanics'); }
  else                   { hide('tabUsage'); show('tabMechanics'); loadMechList(); }
};

window.loadAdminData = async function() {
  el('usageLoading').textContent='Loading stats...';
  hide('usageTable');
  el('adminServiceBars').innerHTML='';

  try {
    // Fetch all usage logs
    const logs = await sb('GET','usage_logs?select=username,date,service,qty&order=created_at.desc');
    // Fetch mechanics
    const mechs = await sb('GET','mechanics?select=username,created_at');

    // Summaries
    const todayStr=today();
    const todayLogs=logs.filter(l=>l.date===todayStr);
    const uniqueMechs=new Set(logs.map(l=>l.username));

    el('summTotal').textContent  = todayLogs.reduce((a,l)=>a+l.qty,0);
    el('summMechs').textContent  = uniqueMechs.size;
    el('summAllTime').textContent= logs.reduce((a,l)=>a+l.qty,0);

    // Build per-mechanic table data
    const mechNames = mechs.map(m=>m.username);
    // Add admin if they used it
    logs.forEach(l=>{ if(!mechNames.includes(l.username)) mechNames.push(l.username); });

    const tableData={};
    mechNames.forEach(u=>{
      tableData[u]={};
      SERVICES.forEach(s=>tableData[u][s]=0);
      tableData[u]._total=0;
      tableData[u]._last='—';
    });

    logs.forEach(l=>{
      if (!tableData[l.username]) return;
      tableData[l.username][l.service]=(tableData[l.username][l.service]||0)+l.qty;
      tableData[l.username]._total=(tableData[l.username]._total||0)+l.qty;
      if (tableData[l.username]._last==='—' || l.date>tableData[l.username]._last) {
        tableData[l.username]._last=l.date;
      }
    });

    // Render table
    const tbody=el('usageTableBody');
    tbody.innerHTML='';
    if (mechNames.length===0) {
      tbody.innerHTML='<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:24px">No mechanics yet</td></tr>';
    } else {
      mechNames.sort().forEach(u=>{
        const d=tableData[u];
        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td><div class="mech-badge"><div class="mech-dot"></div>${u}</div></td>
          ${SERVICES.map(s=>`<td class="td-num ${d[s]?'':'zero'}">${d[s]||'—'}</td>`).join('')}
          <td class="td-total">${d._total||0}</td>
          <td class="td-date">${d._last}</td>
        `;
        tbody.appendChild(tr);
      });
    }
    show('usageTable'); hide('usageLoading');

    // Service bars (today)
    const serviceTotals={};
    SERVICES.forEach(s=>serviceTotals[s]=0);
    todayLogs.forEach(l=>{ serviceTotals[l.service]=(serviceTotals[l.service]||0)+l.qty; });
    const maxVal=Math.max(...Object.values(serviceTotals),1);
    const barsEl=el('adminServiceBars');
    barsEl.innerHTML='';
    SERVICES.forEach(s=>{
      const count=serviceTotals[s];
      const pct=Math.round((count/maxVal)*100);
      const row=document.createElement('div');
      row.className='stats-bar-row';
      row.innerHTML=`
        <span class="stats-bar-name">${s}</span>
        <div class="stats-bar-track"><div class="stats-bar-fill" style="width:0%" data-pct="${pct}"></div></div>
        <span class="stats-bar-count">${count}</span>
      `;
      barsEl.appendChild(row);
    });
    // Animate bars after render
    setTimeout(()=>{
      barsEl.querySelectorAll('.stats-bar-fill').forEach(f=>{
        f.style.width=f.dataset.pct+'%';
      });
    },100);

  } catch(e) {
    el('usageLoading').textContent='Failed to load. Check Supabase tables.';
    show('usageLoading');
    console.error(e);
  }
};

async function loadMechList() {
  el('mechLoading').textContent='Loading mechanics...';
  el('mechList').innerHTML='';
  show('mechLoading');

  try {
    const mechs = await sb('GET','mechanics?select=username,created_at&order=created_at.asc');
    // Get total uses per mechanic
    const logs  = await sb('GET','usage_logs?select=username,qty');
    const uses={};
    logs.forEach(l=>{ uses[l.username]=(uses[l.username]||0)+l.qty; });

    hide('mechLoading');
    const listEl=el('mechList');
    listEl.className='mech-list';

    if (!mechs || mechs.length===0) {
      listEl.innerHTML='<div class="no-mechs">No mechanics added yet.</div>';
      return;
    }

    mechs.forEach(m=>{
      const div=document.createElement('div');
      div.className='mech-item';
      div.innerHTML=`
        <div class="mech-item-left">
          <div class="mech-item-avatar">${m.username.charAt(0).toUpperCase()}</div>
          <div>
            <div class="mech-item-name">${m.username}</div>
            <div class="mech-item-meta">Since ${new Date(m.created_at).toLocaleDateString('en-GB')}</div>
          </div>
        </div>
        <div class="mech-item-right">
          <div style="text-align:center">
            <div class="mech-uses">${uses[m.username]||0}</div>
            <div class="mech-uses-label">total uses</div>
          </div>
          <button class="btn-delete-mech" onclick="deleteMechanic('${m.username}')" title="Remove mechanic">
            <svg viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 4V3h6v1M6 7v5M10 7v5M3 4l1 9h8l1-9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      `;
      listEl.appendChild(div);
    });
  } catch(e) {
    el('mechLoading').textContent='Failed to load mechanics.';
    console.error(e);
  }
}

window.addMechanic = async function() {
  const username = el('newMechUser').value.trim().toLowerCase();
  const password = el('newMechPass').value.trim();
  const errEl    = el('mechFormError');
  errEl.textContent='';

  if (!username || !password) { errEl.textContent='Both fields required.'; return; }
  if (username.length < 3)    { errEl.textContent='Username must be 3+ characters.'; return; }
  if (password.length < 4)    { errEl.textContent='Password must be 4+ characters.'; return; }
  if (username===ADMIN_USER)  { errEl.textContent='That username is reserved.'; return; }

  try {
    await sb('POST','mechanics',[{ username, password, created_at: nowISO() }]);
    el('newMechUser').value='';
    el('newMechPass').value='';
    loadMechList();
  } catch(e) {
    if (e.message.includes('duplicate') || e.message.includes('unique')) {
      errEl.textContent='Username already exists.';
    } else {
      errEl.textContent='Failed to add. Try again.';
      console.error(e);
    }
  }
};

window.deleteMechanic = async function(username) {
  if (!confirm(`Remove mechanic "${username}"? Their usage logs will be kept.`)) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/mechanics?username=eq.${encodeURIComponent(username)}`, {
      method:'DELETE',
      headers:{ 'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}` }
    });
    loadMechList();
  } catch(e) { alert('Failed to delete.'); console.error(e); }
};


/* ══════════════════════════════════════════════════════════
   EXPORT TO EXCEL
══════════════════════════════════════════════════════════ */
window.exportExcel = async function() {
  const btn = el('exportBtn');
  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2V10M8 10L5 7M8 10L11 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12H14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> Exporting...';

  try {
    const logs  = await sb('GET','usage_logs?select=username,date,service,qty,created_at&order=created_at.desc');
    const mechs = await sb('GET','mechanics?select=username,created_at&order=created_at.asc');

    // ── Sheet 1: Per-mechanic summary ──────────────────────
    const mechNames = mechs.map(m => m.username);
    logs.forEach(l => { if (!mechNames.includes(l.username)) mechNames.push(l.username); });

    const summary = {};
    mechNames.forEach(u => {
      summary[u] = {};
      SERVICES.forEach(s => summary[u][s] = 0);
      summary[u]._total = 0;
      summary[u]._last  = '—';
    });
    logs.forEach(l => {
      if (!summary[l.username]) return;
      summary[l.username][l.service] = (summary[l.username][l.service] || 0) + l.qty;
      summary[l.username]._total     = (summary[l.username]._total || 0) + l.qty;
      if (summary[l.username]._last === '—' || l.date > summary[l.username]._last)
        summary[l.username]._last = l.date;
    });

    const sheet1 = [
      ['Mechanic', ...SERVICES, 'Total Uses', 'Last Active']
    ];
    mechNames.sort().forEach(u => {
      sheet1.push([u, ...SERVICES.map(s => summary[u][s] || 0), summary[u]._total || 0, summary[u]._last]);
    });

    // ── Sheet 2: Raw usage log ─────────────────────────────
    const sheet2 = [['Date', 'Mechanic', 'Service', 'Quantity', 'Logged At']];
    logs.forEach(l => {
      sheet2.push([l.date, l.username, l.service, l.qty, new Date(l.created_at).toLocaleString('en-GB')]);
    });

    // ── Build .xlsx manually (simple XML-based) ────────────
    buildAndDownloadXLSX(sheet1, sheet2);

  } catch(e) {
    alert('Export failed. Please try again.');
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2V10M8 10L5 7M8 10L11 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12H14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="1" y="11" width="14" height="4" rx="1" stroke="currentColor" stroke-width="1.2"/></svg> Export Excel';
  }
};

function buildAndDownloadXLSX(sheet1, sheet2) {
  // Use SheetJS via CDN loaded dynamically
  if (window.XLSX) {
    doExport(sheet1, sheet2);
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  script.onload = () => doExport(sheet1, sheet2);
  script.onerror = () => alert('Could not load Excel library. Check your connection.');
  document.head.appendChild(script);
}

function doExport(sheet1, sheet2) {
  const wb = XLSX.utils.book_new();

  // Sheet 1 — Summary
  const ws1 = XLSX.utils.aoa_to_sheet(sheet1);
  // Style header row width
  ws1['!cols'] = sheet1[0].map((_, i) => ({ wch: i === 0 ? 18 : 14 }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Usage Summary');

  // Sheet 2 — Raw Logs
  const ws2 = XLSX.utils.aoa_to_sheet(sheet2);
  ws2['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Raw Logs');

  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `antera-mechanic-stats-${date}.xlsx`);
}

/* ══════════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════════ */
function boot() {
  initCalc();
  updateTotal();

  const loader=el('loader');
  setTimeout(()=>{
    loader.classList.add('hide');
    setTimeout(()=>loader.style.display='none',650);
    show('authScreen');
  }, 1200);
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
