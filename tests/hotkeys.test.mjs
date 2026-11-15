import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SEND_SHORTCUT,DEFAULT_STEER_SHORTCUT,sameShortcut,shortcutFromEvent,matchesShortcut,validShortcut,shortcutLabel} from '../cockpit/hotkeys.js';
const event=(extra={})=>({key:'Enter',metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,...extra});
test('send shortcut requires exact modifiers and excludes IME and repeats',()=>{
 assert.equal(matchesShortcut(event(),DEFAULT_SEND_SHORTCUT),true);
 for(const extra of [{metaKey:true},{shiftKey:true},{isComposing:true},{repeat:true}]) assert.equal(matchesShortcut(event(extra),DEFAULT_SEND_SHORTCUT),false);
 assert.equal(shortcutLabel(DEFAULT_SEND_SHORTCUT),'Enter');
});
test('custom shortcuts are validated; editing and OS combinations stay reserved',()=>{
 const custom=shortcutFromEvent(event({metaKey:false,ctrlKey:true,key:'Enter'}));
 assert.equal(validShortcut(custom),true);
 assert.equal(matchesShortcut(event({metaKey:false,ctrlKey:true}),custom),true);
 assert.equal(matchesShortcut(event(),custom),false);
 for(const key of ['q','w','c','v','r','1','Escape','Tab']) assert.equal(shortcutFromEvent(event({key,metaKey:true})),null);
 assert.equal(shortcutFromEvent(event({key:'a',metaKey:false})),null);
 assert.equal(validShortcut({key:'Enter',meta:'yes'}),false);
 assert.equal(validShortcut({key:'Enter',meta:false,ctrl:false,alt:false,shift:false}),true);
});

test('send and steer are separate actions with distinct defaults',()=>{
 assert.equal(matchesShortcut(event(),DEFAULT_SEND_SHORTCUT),true);
 assert.equal(matchesShortcut(event(),DEFAULT_STEER_SHORTCUT),false);
 assert.equal(matchesShortcut(event({metaKey:true}),DEFAULT_STEER_SHORTCUT),true);
 assert.equal(matchesShortcut(event({metaKey:true}),DEFAULT_SEND_SHORTCUT),false);
 assert.equal(sameShortcut(DEFAULT_SEND_SHORTCUT,DEFAULT_STEER_SHORTCUT),false);
 assert.equal(sameShortcut({...DEFAULT_STEER_SHORTCUT},DEFAULT_STEER_SHORTCUT),true);
});
