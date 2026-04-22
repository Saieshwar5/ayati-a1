async function api(path, opts){ const res = await fetch(path, opts); return res.json().catch(()=>({})); }
function slugify(title){ return title.trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,''); }
async function loadPages(){ const pages = await api('/api/pages'); const ul=document.getElementById('pages'); ul.innerHTML=''; (pages||[]).forEach(p=>{ const li=document.createElement('li'); const a=document.createElement('a'); a.href='#'; a.textContent=p.title||p.slug; a.onclick=async e=>{ e.preventDefault(); openPage(p.slug); }; li.appendChild(a); ul.appendChild(li); }); }
async function openPage(slug){ const data = await api('/api/page?name='+encodeURIComponent(slug)); document.getElementById('title').value = data.name ? (data.name.replace(/-/g,' ')) : slug; document.getElementById('content').value = data.content || ''; document.getElementById('preview').hidden = true; }
async function savePage(){ const title=document.getElementById('title').value || 'untitled'; const slug=slugify(title)||'untitled'; const content=document.getElementById('content').value||''; const res=await api('/api/page',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:slug,content}) }); await loadPages(); alert(res.ok ? 'Saved' : ('Error: '+(res.error||'unknown'))); }
function togglePreview(){ const preview=document.getElementById('preview'); const textarea=document.getElementById('content'); if(preview.hidden){ preview.innerHTML = marked.parse(textarea.value||''); preview.hidden=false; } else { preview.hidden=true; } }
document.getElementById('newBtn').addEventListener('click', ()=>{ document.getElementById('title').value=''; document.getElementById('content').value=''; document.getElementById('preview').hidden=true; });
document.getElementById('saveBtn').addEventListener('click', savePage);
document.getElementById('previewBtn').addEventListener('click', togglePreview);
loadPages();
