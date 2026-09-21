#!/usr/bin/env node
'use strict';
// The browser and automatic synchronizer must execute the same core/planning
// source. A UI-only deployment must fail before it can classify daily records
// differently from the scheduled synchronization job.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),candidate=process.argv[2]||path.join(root,'public','schedule.html'),htmlPath=path.resolve(process.cwd(),candidate),relative=path.relative(root,htmlPath);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Schedule HTML must be inside the application repository');
const normalize=value=>String(value).replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'),html=normalize(fs.readFileSync(htmlPath,'utf8')),files=[['core','schedule-core.cjs'],['planning','schedule-planning.cjs']],hashes={};
for(const [label,name]of files){const source=normalize(fs.readFileSync(path.join(__dirname,name),'utf8'));if(!html.includes(source))throw Error(label+' runtime differs between schedule.html and integration/'+name);hashes[label]=crypto.createHash('sha256').update(source).digest('hex');}
process.stdout.write(JSON.stringify({ok:true,html:relative.replaceAll('\\','/'),hashes})+'\n');
