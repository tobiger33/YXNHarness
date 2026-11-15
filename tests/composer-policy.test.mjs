import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canAutoApprove } from '../cockpit/approval-policy.js';
import { createAttachment, getAttachment } from '../scripts/attachments.mjs';

test('automatic approval stays scoped to the built-in visual edit', () => {
  const agent = {adapter: {adapterId: 'workspace-edit', source: 'builtin:workspace-edit'}};
  const proposal = {status:'pending', files:[{path:'examples/foreign-booking/styles.css'}]};
  assert.equal(canAutoApprove('auto', agent, proposal), true);
  for (const mode of ['ask','full',undefined]) assert.equal(canAutoApprove(mode, agent, proposal), false);
  assert.equal(canAutoApprove('auto', {adapter:{adapterId:'workspace-edit',source:'custom'}}, proposal), false);
  assert.equal(canAutoApprove('auto', agent, {...proposal,status:'accepted'}), false);
  assert.equal(canAutoApprove('auto', agent, {...proposal,files:[{path:'package.json'}]}), false);
  assert.equal(canAutoApprove('auto', agent, {...proposal,files:[...proposal.files,{path:'secrets.env'}]}), false);
});

test('external files round-trip as downloads, invalid images stay blocked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'yxn-composer-'));
  try {
    const body = Buffer.from('<script>untrusted file contents</script>');
    const result = await createAttachment(root, {buffer:body,filename:'reference.html',declaredType:'text/html'});
    assert.equal(result.status,'written');
    assert.equal(result.attachment.mimeType,'application/octet-stream');
    assert.equal(result.attachment.width,null);
    const stored = await getAttachment(root,result.attachment.attachmentId);
    assert.deepEqual(stored.body,body);
    assert.equal(stored.meta.filename,'reference.html');
    const svg = await createAttachment(root,{buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>untrusted</script></svg>'),filename:'reference.svg',declaredType:'image/svg+xml'});
    assert.equal(svg.status,'written');
    assert.equal(svg.attachment.mimeType,'application/octet-stream');
    const fake = await createAttachment(root,{buffer:body,filename:'fake.png',declaredType:'image/png'});
    assert.equal(fake.status,'blocked');
    const large = await createAttachment(root,{buffer:Buffer.alloc(12*1024*1024+1),filename:'large.bin'});
    assert.equal(large.status,'blocked');
  } finally { await rm(root,{recursive:true,force:true}); }
});
