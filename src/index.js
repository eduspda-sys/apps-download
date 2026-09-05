const HTML = { "content-type": "text/html; charset=UTF-8" };
const JSONH = { "content-type": "application/json; charset=UTF-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") return new Response(storePage(), { headers: HTML });

    if (path === "/admin") {
      if (!isAdmin(request, env)) return unauthorized();
      return new Response(adminPage(), { headers: HTML });
    }

    if (path.startsWith("/api/")) {
      if (!isAdmin(request, env)) return unauthorized();

      if (path === "/api/files" && request.method === "GET") {
        const listed = await env.FILES.list({ limit: 500, include: ["customMetadata"] });
        return json(listed.objects
          .filter((o) => !o.key.startsWith("_system/"))
          .map((o) => fileInfo(o)));
      }

      if (path === "/api/upload" && request.method === "POST") {
        try {
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File)) return json({ error: "Arquivo não enviado" }, 400);

          const clean = sanitizeFilename(file.name);
          const realFormat = extensionOf(file.name);
          const isApk = realFormat === "APK";
          const folder = isApk ? "apks" : sanitizeFolder(form.get("folder") || inferFolder(file.name));
          const displayNameRaw = String(form.get("displayName") || "").trim();
          const displayName = (displayNameRaw || removeExtension(file.name)).slice(0, 160);
          const shortUrl = normalizeShortUrl(form.get("shortUrl"));
          if (shortUrl.error) return json({ error: shortUrl.error }, 400);
          const downloaderCode = isApk ? String(form.get("downloaderCode") || "").trim().slice(0, 80) : "";
          const key = `${folder}/${clean}`;
          const existed = await env.FILES.head(key);

          await env.FILES.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || "application/octet-stream" },
            customMetadata: {
              originalName: file.name,
              displayName,
              shortUrl: shortUrl.value,
              downloaderCode,
            },
          });

          return json({
            ok: true,
            replaced: Boolean(existed),
            key,
            name: displayName,
            originalName: file.name,
            format: realFormat,
            shortUrl: shortUrl.value,
            downloaderCode,
            url: fileUrl(key),
          });
        } catch (err) {
          return json({ error: "Falha ao enviar arquivo", detail: String(err?.message || err) }, 500);
        }
      }

      if (path === "/api/file-meta" && request.method === "PATCH") {
        try {
          const body = await request.json();
          const key = String(body.key || "");
          if (!key) return json({ error: "Arquivo inválido" }, 400);

          const object = await env.FILES.get(key);
          if (!object) return json({ error: "Arquivo não encontrado" }, 404);

          const old = object.customMetadata || {};
          const originalName = old.originalName || key.split("/").pop() || "arquivo";
          const displayName = String(body.displayName || removeExtension(originalName)).trim().slice(0, 160);
          const shortUrl = normalizeShortUrl(body.shortUrl);
          if (shortUrl.error) return json({ error: shortUrl.error }, 400);
          const isApk = extensionOf(originalName) === "APK";
          const downloaderCode = isApk ? String(body.downloaderCode || "").trim().slice(0, 80) : "";

          await env.FILES.put(key, object.body, {
            httpMetadata: object.httpMetadata,
            customMetadata: {
              ...old,
              originalName,
              displayName,
              shortUrl: shortUrl.value,
              downloaderCode,
            },
          });

          return json({ ok: true });
        } catch (err) {
          return json({ error: "Falha ao atualizar informações", detail: String(err?.message || err) }, 500);
        }
      }

      if (path.startsWith("/api/files/") && request.method === "DELETE") {
        const key = decodeURIComponent(path.slice("/api/files/".length));
        if (!key) return json({ error: "Arquivo inválido" }, 400);
        await env.FILES.delete(key);
        return json({ ok: true });
      }

      return json({ error: "Rota não encontrada" }, 404);
    }

    if (path.startsWith("/files/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice("/files/".length));
      const object = await env.FILES.get(key);
      if (!object) return new Response("Arquivo não encontrado", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=3600");
      const originalName = object.customMetadata?.originalName || key.split("/").pop();
      const disposition = String(originalName).toLowerCase().endsWith(".apk") ? "attachment" : "inline";
      headers.set("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(originalName)}`);
      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
};

function fileInfo(o) {
  const base = o.key.split("/").pop() || o.key;
  const fallbackOriginal = base.replace(/^\d{10,}-/, "");
  const originalName = o.customMetadata?.originalName || fallbackOriginal;
  return {
    key: o.key,
    name: o.customMetadata?.displayName || removeExtension(originalName),
    originalName,
    format: extensionOf(originalName),
    shortUrl: o.customMetadata?.shortUrl || "",
    downloaderCode: o.customMetadata?.downloaderCode || "",
    size: o.size,
    uploaded: o.uploaded,
    url: fileUrl(o.key),
  };
}

function normalizeShortUrl(value) {
  const v = String(value || "").trim();
  if (!v) return { value: "" };
  if (!/^https?:\/\//i.test(v)) return { value: "", error: "O link encurtado precisa começar com http:// ou https://" };
  if (v.length > 500) return { value: "", error: "Link encurtado muito longo" };
  return { value: v };
}

function fileUrl(key) {
  return "/files/" + String(key).split("/").map(encodeURIComponent).join("/");
}

function extensionOf(name) {
  const base = String(name).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1 ? base.slice(i + 1).toUpperCase() : "ARQUIVO";
}

function removeExtension(name) {
  const base = String(name).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function sanitizeFilename(name) {
  return String(name)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "arquivo";
}

function sanitizeFolder(value) {
  const v = String(value).toLowerCase();
  return ["apks", "images", "files"].includes(v) ? v : "files";
}

function inferFolder(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".apk")) return "apks";
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(lower)) return "images";
  return "files";
}

function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  try {
    const decoded = atob(auth.slice(6));
    const i = decoded.indexOf(":");
    const user = i >= 0 ? decoded.slice(0, i) : "";
    const pass = i >= 0 ? decoded.slice(i + 1) : "";
    return user === "admin" && pass === env.ADMIN_PASSWORD;
  } catch {
    return false;
  }
}

function unauthorized() {
  return new Response("Acesso restrito", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="TVON Store Admin", charset="UTF-8"' },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSONH });
}

function storePage() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TVON Store</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:#080b12;color:#f5f7fb}.wrap{max-width:1120px;margin:auto;padding:32px 20px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}.brand{font-size:26px;font-weight:800}.brand span{color:#6da8ff}.muted{color:#8f9aab}.hero{padding:34px;border:1px solid #20283a;border-radius:24px;background:linear-gradient(135deg,#111827,#0b1020);margin-bottom:26px}.hero h1{font-size:38px;margin:0 0 8px}.empty{text-align:center;padding:55px 20px;color:#8993a5;border:1px dashed #273149;border-radius:18px}.admin{font-size:13px;color:#8993a5;text-decoration:none}</style>
</head><body><div class="wrap"><div class="top"><div class="brand">TVON <span>Store</span></div><a class="admin" href="/admin">Admin</a></div><section class="hero"><h1>Aplicativos em um só lugar.</h1><div class="muted">Downloads rápidos e organizados.</div></section><div class="empty">Nenhum aplicativo publicado ainda.</div></div></body></html>`;
}

function adminPage() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TVON Store • Admin</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:#080b12;color:#f4f7fb}.wrap{max-width:1180px;margin:auto;padding:30px 18px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{margin:0;font-size:25px}.sub{color:#8793a7;margin-top:5px}.box{border:1px solid #20283a;background:#0e1421;border-radius:20px;padding:20px;margin-bottom:20px}.drop{border:1px dashed #384764;border-radius:16px;padding:26px}select,input,button{font:inherit}select,input[type=file],input[type=text],input[type=url]{background:#0a0f19;color:#fff;border:1px solid #2a3449;padding:11px;border-radius:10px;min-width:0}.controls{display:grid;grid-template-columns:1.3fr 1fr 150px auto;gap:10px;margin-top:15px}.meta-controls{display:grid;grid-template-columns:1fr 1.2fr .7fr;gap:10px;margin-top:10px}button{background:#2878ff;color:white;border:0;padding:11px 16px;border-radius:10px;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}button.secondary{background:#182338;color:#bcd2ff}button.danger{background:#2a1014;color:#ff8a95}.toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:12px}.search{width:min(100%,420px)}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:15px;align-items:center;padding:16px 0;border-bottom:1px solid #1b2333}.row:last-child{border:0}.name{font-weight:750;font-size:16px}.filename,.details{font-size:12px;color:#8793a7;margin-top:4px;overflow-wrap:anywhere}.details strong{color:#c4cee0}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.badge{display:inline-flex;border:1px solid #2a3449;background:#0a0f19;border-radius:999px;padding:4px 8px;font-size:11px;color:#b9c4d7;margin-left:6px}.link{color:#7eacff;text-decoration:none}.status{margin-top:12px;color:#9eabc0;min-height:18px}.status.ok{color:#78e59a}.status.err{color:#ff8a95}.empty{padding:20px 0;color:#8793a7}.hidden{display:none!important}.hint{font-size:12px;color:#728096;margin-top:8px}@media(max-width:780px){.controls,.meta-controls{grid-template-columns:1fr}.row{grid-template-columns:1fr}.actions{justify-content:flex-start}.toolbar{align-items:stretch;flex-direction:column}.search{width:100%}}
</style></head>
<body><div class="wrap">
<div class="top"><div><h1>TVON Store • Admin</h1><div class="sub">Upload e gerenciamento de arquivos no R2</div></div><a class="link" href="/">Ver loja</a></div>
<div class="box"><div class="drop"><strong>Enviar arquivo</strong><div class="sub">O link direto mantém o nome do arquivo. Reenviar o mesmo nome substitui o arquivo sem mudar o endereço.</div>
<div class="controls"><input id="file" type="file"><input id="displayName" type="text" maxlength="160" placeholder="Nome para identificar"><select id="folder"><option value="apks">APK</option><option value="images">Imagem</option><option value="files">Outro arquivo</option></select><button id="uploadBtn" type="button">Enviar</button></div>
<div class="meta-controls"><input id="shortUrl" type="url" maxlength="500" placeholder="Link encurtado Abrela (opcional)"><input id="downloaderCode" type="text" maxlength="80" placeholder="Código Downloader (somente APK)"><div class="hint">Você pode preencher esses dados depois em Editar dados.</div></div>
<div id="status" class="status"></div></div></div>
<div class="box"><div class="toolbar"><strong>Arquivos enviados</strong><input id="search" class="search" type="text" placeholder="Pesquisar nome, APK, código Downloader, Abrela..."></div><div id="list" class="sub">Carregando...</div></div>
</div>
<script>
const fileInput=document.getElementById('file');
const displayNameInput=document.getElementById('displayName');
const folderInput=document.getElementById('folder');
const shortUrlInput=document.getElementById('shortUrl');
const downloaderCodeInput=document.getElementById('downloaderCode');
const uploadBtn=document.getElementById('uploadBtn');
const statusEl=document.getElementById('status');
const listEl=document.getElementById('list');
const searchInput=document.getElementById('search');
let allFiles=[];

function fmt(n){if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
function setStatus(text,type){statusEl.textContent=text||'';statusEl.className='status'+(type?' '+type:'')}
async function readJson(r){const t=await r.text();if(!t)return{};try{return JSON.parse(t)}catch{return{error:t}}}
async function copyText(text,label){try{await navigator.clipboard.writeText(text);setStatus((label||'Link')+' copiado.','ok')}catch{prompt('Copie:',text)}}
function isApkSelection(){const f=fileInput.files[0];return folderInput.value==='apks'||(f&&f.name.toLowerCase().endsWith('.apk'))}
function syncApkField(){downloaderCodeInput.disabled=!isApkSelection();downloaderCodeInput.placeholder=isApkSelection()?'Código Downloader (opcional)':'Código Downloader — somente APK';if(downloaderCodeInput.disabled)downloaderCodeInput.value=''}

function renderFiles(){
 const q=searchInput.value.trim().toLowerCase();
 const data=!q?allFiles:allFiles.filter(function(x){return[x.name,x.originalName,x.format,x.key,x.shortUrl,x.downloaderCode].join(' ').toLowerCase().includes(q)});
 listEl.replaceChildren();
 if(!data.length){const e=document.createElement('div');e.className='empty';e.textContent=q?'Nenhum arquivo encontrado.':'Nenhum arquivo enviado.';listEl.appendChild(e);return}
 data.forEach(function(item){
  const row=document.createElement('div');row.className='row';
  const info=document.createElement('div');
  const name=document.createElement('div');name.className='name';name.textContent=item.name||item.originalName;
  const badge=document.createElement('span');badge.className='badge';badge.textContent=item.format||'ARQUIVO';name.appendChild(badge);
  const filename=document.createElement('div');filename.className='filename';filename.textContent=item.originalName+' • '+fmt(item.size);
  const details=document.createElement('div');details.className='details';
  const parts=[];if(item.shortUrl)parts.push('Abrela: '+item.shortUrl);if(item.downloaderCode)parts.push('Downloader: '+item.downloaderCode);details.textContent=parts.join('   •   ')||'Sem link encurtado/código cadastrado';
  info.append(name,filename,details);
  const actions=document.createElement('div');actions.className='actions';
  const direct=document.createElement('button');direct.type='button';direct.textContent='Link direto';direct.addEventListener('click',function(){copyText(location.origin+item.url,'Link direto')});actions.appendChild(direct);
  if(item.shortUrl){const short=document.createElement('button');short.type='button';short.className='secondary';short.textContent='Abrela';short.addEventListener('click',function(){copyText(item.shortUrl,'Abrela')});actions.appendChild(short)}
  if(item.downloaderCode){const code=document.createElement('button');code.type='button';code.className='secondary';code.textContent='Código '+item.downloaderCode;code.addEventListener('click',function(){copyText(item.downloaderCode,'Código Downloader')});actions.appendChild(code)}
  const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='Editar dados';edit.addEventListener('click',function(){editMeta(item)});actions.appendChild(edit);
  const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='Excluir';del.addEventListener('click',async function(){if(!confirm('Excluir '+item.originalName+'?'))return;del.disabled=true;try{const r=await fetch('/api/files/'+encodeURIComponent(item.key),{method:'DELETE',credentials:'same-origin'});const j=await readJson(r);if(!r.ok)throw new Error(j.error||'Falha ao excluir');setStatus('Arquivo excluído.','ok');await loadFiles()}catch(e){setStatus(e.message||'Falha ao excluir.','err');del.disabled=false}});actions.appendChild(del);
  row.append(info,actions);listEl.appendChild(row);
 })
}

async function editMeta(item){
 const name=prompt('Nome para identificar:',item.name||'');if(name===null)return;
 const short=prompt('Link encurtado Abrela (pode deixar vazio):',item.shortUrl||'');if(short===null)return;
 let code=item.downloaderCode||'';
 if(item.format==='APK'){const c=prompt('Código Downloader (pode deixar vazio):',code);if(c===null)return;code=c}else{code=''}
 setStatus('Salvando informações...');
 try{const r=await fetch('/api/file-meta',{method:'PATCH',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({key:item.key,displayName:name,shortUrl:short,downloaderCode:code})});const j=await readJson(r);if(!r.ok)throw new Error(j.error||'Falha ao atualizar');setStatus('Informações atualizadas.','ok');await loadFiles()}catch(e){setStatus(e.message||'Falha ao atualizar.','err')}
}

async function loadFiles(){listEl.textContent='Carregando...';try{const r=await fetch('/api/files',{credentials:'same-origin'});const j=await readJson(r);if(!r.ok)throw new Error(j.error||'Falha ao carregar arquivos');allFiles=Array.isArray(j)?j:[];renderFiles()}catch(e){listEl.textContent=e.message||'Falha ao carregar arquivos.'}}

uploadBtn.addEventListener('click',async function(){
 const file=fileInput.files[0];if(!file){setStatus('Selecione um arquivo.','err');return}
 const form=new FormData();form.append('file',file);form.append('displayName',displayNameInput.value);form.append('folder',folderInput.value);form.append('shortUrl',shortUrlInput.value);form.append('downloaderCode',downloaderCodeInput.value);
 uploadBtn.disabled=true;setStatus('Enviando...');
 try{const r=await fetch('/api/upload',{method:'POST',body:form,credentials:'same-origin'});const j=await readJson(r);if(!r.ok)throw new Error(j.error||'Falha no upload');fileInput.value='';displayNameInput.value='';shortUrlInput.value='';downloaderCodeInput.value='';syncApkField();setStatus(j.replaced?'Arquivo substituído mantendo o mesmo link.':'Enviado com sucesso.','ok');await loadFiles()}catch(e){setStatus(e.message||'Falha no upload.','err')}finally{uploadBtn.disabled=false}
});
fileInput.addEventListener('change',syncApkField);folderInput.addEventListener('change',syncApkField);searchInput.addEventListener('input',renderFiles);syncApkField();loadFiles();
</script></body></html>`;
}
