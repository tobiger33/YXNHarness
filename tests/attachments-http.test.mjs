import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCockpitApi} from '../scripts/cockpit-api.mjs';

test('Unicode file names survive upload and safe download over HTTP',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'yxn-files-http-'));
 const api=createCockpitApi({root,port:0,host:'127.0.0.1'});
 try {
  const {url}=await api.listen();
  const filename='Entwurf-ä-🎨.txt',body='Non-image design reference';
  const uploaded=await fetch(`${url}api/v1/attachments`,{method:'POST',headers:{'Content-Type':'text/plain','X-Attachment-Filename':encodeURIComponent(filename),'X-Attachment-Filename-Encoding':'uri'},body});
  assert.equal(uploaded.status,201);
  const result=await uploaded.json();
  assert.equal(result.attachment.filename,filename);
  assert.equal(result.attachment.mimeType,'application/octet-stream');
  const content=await fetch(new URL(result.attachment.contentUrl,url));
  assert.equal(content.status,200);
  assert.equal(await content.text(),body);
  assert.equal(content.headers.get('content-type'),'application/octet-stream');
  assert.equal(content.headers.get('x-content-type-options'),'nosniff');
  assert.equal(content.headers.get('content-disposition'),`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const malformed=await fetch(`${url}api/v1/attachments`,{method:'POST',headers:{'Content-Type':'text/plain','X-Attachment-Filename':'%ZZ','X-Attachment-Filename-Encoding':'uri'},body});
  assert.equal(malformed.status,400);
 } finally {await api.close();await rm(root,{recursive:true,force:true});}
});
