import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export async function isolatedWorkspace(t) {
  const repository=fileURLToPath(new URL('../..',import.meta.url));
  const root=await mkdtemp(path.join(os.tmpdir(),'yxn-cockpit-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'examples'),{recursive:true});
  await cp(path.join(repository,'examples','foreign-booking'),path.join(root,'examples','foreign-booking'),{recursive:true});
  for(const filename of ['harness.host.json','harness.config.json']) await writeFile(path.join(root,filename),await readFile(path.join(repository,filename)));
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=Harness QA','-c','user.email=qa@example.invalid','commit','-qm','Fixture baseline'],{cwd:root});
  return root;
}
