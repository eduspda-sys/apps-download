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
        const listed = await env.FILES.list({ limit: 500 });
        return json(listed.objects.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          url: `/files/${encodeURIComponent(o.key)}`,
        })));
      }

      if (path === "/api/upload" && request.method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ error: "Arquivo não enviado" }, 400);

        const folder = sanitizeFolder(form.get("folder") || inferFolder(file.name));
        const clean = sanitizeFilename(file.name);
        const key = `${folder}/${Date.now()}-${clean}`;

        await env.FILES.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
          customMetadata: { originalName: file.name },
        });

        return json({ ok: true, key, url: `/files/${encodeURIComponent(key)}` });
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
      headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(key.split('/').pop())}`);
      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
};

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

function storePage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TVON Store</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:#080b12;color:#f5f7fb}.wrap{max-width:1120px;margin:auto;padding:32px 20px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}.brand{font-size:26px;font-weight:800}.brand span{color:#6da8ff}.muted{color:#8f9aab}.hero{padding:34px;border:1px solid #20283a;border-radius:24px;background:linear-gradient(135deg,#111827,#0b1020);margin-bottom:26px}.hero h1{font-size:38px;margin:0 0 8px}.empty{text-align:center;padding:55px 20px;color:#8993a5;border:1px dashed #273149;border-radius:18px}.admin{font-size:13px;color:#8993a5;text-decoration:none}</style></head><body><div class="wrap"><div class="top"><div class="brand">TVON <span>Store</span></div><a class="admin" href="/admin">Admin</a></div><section class="hero"><h1>Aplicativos em um só lugar.</h1><div class="muted">Downloads rápidos e organizados.</div></section><div class="empty">Nenhum aplicativo publicado ainda.</div></div></body></html>`;
}

function adminPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TVON Store • Admin</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:#080b12;color:#f4f7fb}.wrap{max-width:1050px;margin:auto;padding:30px 18px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{margin:0;font-size:25px}.sub{color:#8793a7;margin-top:5px}.box{border:1px solid #20283a;background:#0e1421;border-radius:20px;padding:20px;margin-bottom:20px}.drop{border:1px dashed #384764;border-radius:16px;padding:28px;text-align:center}select,input,button{font:inherit}.controls{display:flex;gap:10px;flex-wrap:wrap;margin-top:15px}select,input[type=file]{background:#0a0f19;color:#fff;border:1px solid #2a3449;padding:11px;border-radius:10px}button{background:#2878ff;color:white;border:0;padding:11px 18px;border-radius:10px;font-weight:700;cursor:pointer}button.danger{background:#2a1014;color:#ff8a95}.row{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid #1b2333}.row:last-child{border:0}.name{overflow:hidden;text-overflow:ellipsis}.small{font-size:12px;color:#8d98aa}.link{color:#7eacff;text-decoration:none}.status{margin-top:12px;color:#9eabc0}@media(max-width:620px){.row{grid-template-columns:1fr}.row button{width:100%}}</style></head><body><div class="wrap"><div class="top"><div><h1>TVON Store • Admin</h1><div class="sub">Upload e gerenciamento de arquivos no R2</div></div><a class="link" href="/">Ver loja</a></div><div class="box"><div class="drop"><strong>Enviar arquivo</strong><div class="sub">APK, imagem ou outro arquivo</div><div class="controls"><input id="file" type="file"><select id="folder"><option value="apks">APK</option><option value="images">Imagem</option><option value="files">Outro arquivo</option></select><button onclick="upload()">Enviar</button></div><div id="status" class="status"></div></div></div><div class="box"><strong>Arquivos enviados</strong><div id="list" class="sub" style="margin-top:12px">Carregando...</div></div></div><script>
const $=s=>document.querySelector(s);function fmt(n){if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}async function load(){const r=await fetch('/api/files');if(!r.ok){location.reload();return}const a=await r.json(),el=$('#list');if(!a.length){el.innerHTML='<div class="sub">Nenhum arquivo enviado.</div>';return}el.innerHTML=a.map(x=>'<div class="row"><div><div class="name">'+esc(x.key)+'</div><div class="small">'+fmt(x.size)+'</div></div><button onclick="copyLink(\''+js(x.url)+'\')">Copiar link</button><button class="danger" onclick="del(\''+js(x.key)+'\')">Excluir</button></div>').join('')}async function upload(){const f=$('#file').files[0];if(!f){$('#status').textContent='Selecione um arquivo.';return}const d=new FormData();d.append('file',f);d.append('folder',$('#folder').value);$('#status').textContent='Enviando...';const r=await fetch('/api/upload',{method:'POST',body:d});const j=await r.json();if(!r.ok){$('#status').textContent=j.error||'Falha no upload';return}$('#status').textContent='Enviado com sucesso.';$('#file').value='';await load()}async function del(k){if(!confirm('Excluir este arquivo?'))return;await fetch('/api/files/'+encodeURIComponent(k),{method:'DELETE'});load()}async function copyLink(u){await navigator.clipboard.writeText(location.origin+u);alert('Link copiado')}function esc(s){return String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}function js(s){return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}load();
</script></body></html>`;
}
