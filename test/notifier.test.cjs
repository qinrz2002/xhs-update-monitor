'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {NativeNotifier}=require('../src/notifier.cjs');
class Notification extends EventEmitter {static isSupported(){return true}constructor(options){super();this.options=options;Notification.last=this}show(){this.emit('show')}close(){this.emit('close',{reason:'applicationHidden'})}}
test('native timeout and programmatic dismissal do not acknowledge; user close does',()=>{
 const ack=[];const notifier=new NativeNotifier(Notification,{acknowledge:ids=>ack.push(ids),view:()=>{}});notifier.show([{eventId:'a',author:'A'}]);const n=Notification.last;
 n.emit('close',{reason:'timedOut'});assert.equal(ack.length,0);n.emit('close',{});assert.equal(ack.length,0);n.emit('close',{reason:'userCanceled'});assert.deepEqual(ack,[['a']]);
});
test('notification actions separate view from close and never clear concurrent new IDs',()=>{
 const ack=[];let views=0;const notifier=new NativeNotifier(Notification,{acknowledge:ids=>ack.push(ids),view:()=>views++});
 notifier.show([{eventId:'a',author:'A'}]);const old=Notification.last;
 notifier.show([{eventId:'a',author:'A'},{eventId:'b',author:'B'}]);const current=Notification.last;
 assert.equal(ack.length,0);assert.equal(current.options.silent,true);assert.equal(current.options.title,'发现 2 篇新笔记');assert.equal(current.options.actions.length,2);
 old.emit('close',{reason:'userCanceled'});assert.deepEqual(ack,[['a']]);current.emit('action',{actionIndex:0});assert.equal(views,1);assert.equal(ack.length,1);
 current.emit('action',{actionIndex:1});assert.deepEqual(ack,[['a'],['a','b']]);
});
test('notification includes article titles and reports native failure without acknowledgement',()=>{
 const observations=[],ack=[];const notifier=new NativeNotifier(Notification,{acknowledge:ids=>ack.push(ids),view:()=>{},observed:event=>observations.push(event)});
 notifier.show([{eventId:'a',author:'作者',title:'文章标题'}]);assert.match(Notification.last.options.body,/文章标题/);
 Notification.last.emit('failed');assert.deepEqual(observations,['shown','failed']);assert.equal(ack.length,0);
});
