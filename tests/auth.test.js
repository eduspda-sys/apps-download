import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const base = 'https://tvon-store.example';
const catalog = [{id:'a',name:'Exemplo',published:true,apkKey:'store/a/test.apk'}];
const env = {
  TVON_INTERNAL_KEY: 'integration-test-secret',
  ADMIN_PASSWORD: 'legacy-password',
  FILES: {
    async get(key) { return key === '_system/store.json' ? {text:async()=>JSON.stringify(catalog)} : null; },
    async list() { return {objects:[]}; }
  }
};
const req = (path,headers={})=>worker.fetch(new Request(base+path,{headers}),env);

test('vitrine pública permanece acessível',async()=>{
  const response=await req('/');
  assert.equal(response.status,200);
});

test('catálogo público expõe apenas aplicativos publicados',async()=>{
  const response=await req('/api/store');
  assert.equal(response.status,200);
  assert.equal((await response.json()).length,1);
});

test('editor bloqueado sem autenticação e sem desafio Basic',async()=>{
  const response=await req('/admin');
  assert.equal(response.status,404);
  assert.equal(response.headers.has('www-authenticate'),false);
});

test('senha Basic antiga não permite acesso',async()=>{
  const response=await req('/admin',{authorization:'Basic '+Buffer.from('admin:legacy-password').toString('base64')});
  assert.equal(response.status,404);
});

test('API administrativa bloqueada sem chave',async()=>{
  const response=await req('/api/apps');
  assert.equal(response.status,404);
});

test('segredo inválido é rejeitado',async()=>{
  const response=await req('/admin',{'X-MyStore-Internal-Key':'incorrect'});
  assert.equal(response.status,404);
});

test('chave correta permite editor e API',async()=>{
  const headers={'X-MyStore-Internal-Key':'integration-test-secret'};
  assert.equal((await req('/admin',headers)).status,200);
  const response=await req('/api/apps',headers);
  assert.equal(response.status,200);
  assert.equal((await response.json()).length,1);
});
