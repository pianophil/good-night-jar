import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {createApp,verifySignature} from '../server/app.mjs';

test('signature accepts current authentic bytes and rejects replay, tampering and malformed signatures',()=>{
 const now=Date.now(),t=Math.floor(now/1000),body='{"id":"evt_1"}',secret='test';
 const sig=createHmac('sha256',secret).update(`${t}.${body}`).digest('hex');
 assert.equal(verifySignature(body,`t=${t},v1=${sig}`,secret,now),true);
 assert.equal(verifySignature(body+' ',`t=${t},v1=${sig}`,secret,now),false);
 assert.equal(verifySignature(body,`t=${t},v1=${sig}`,secret,now+301000),false);
 assert.equal(verifySignature(body,`t=${t},v1=bad`,secret,now),false);
});

test('full two-person lifecycle, payment gating, conflicting edits, invites, expiry and account deletion',async t=>{
 const mails=[],subscriptions=new Map(),customers=new Map(),sessions=new Map();let customerCount=0,checkoutCount=0,eventCount=0,time=Date.now();
 const env={APP_ORIGIN:'http://localhost:3111',STRIPE_SECRET_KEY:'sk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_test',STRIPE_PRICE_MONTHLY:'price_month',STRIPE_PRICE_YEARLY:'price_year',TERMS_URL:'https://example.com/terms',PRIVACY_URL:'https://example.com/privacy',IMPRINT_URL:'https://example.com/imprint'};
 const transport=async(url,options={})=>{
  const u=new URL(url),path=u.pathname.replace('/v1/',''),fields=new URLSearchParams(options.body);
  let result;
  if(path.startsWith('prices/'))result={id:path.split('/')[1],active:true,currency:'eur',tax_behavior:'inclusive',unit_amount:path.endsWith('year')?2499:299,recurring:{interval:path.endsWith('year')?'year':'month',interval_count:1}};
  else if(path==='customers'){result={id:'cus_'+ ++customerCount};customers.set(fields.get('email'),result.id)}
  else if(path==='subscriptions')result={data:[...subscriptions.values()].filter(s=>s.customer===u.searchParams.get('customer'))};
  else if(path.startsWith('subscriptions/')){result=subscriptions.get(path.split('/')[1]);if(options.method==='DELETE')result.status='canceled'}
  else if(path==='checkout/sessions'){const id='cs_'+ ++checkoutCount;result={id,status:'open',url:'https://checkout.stripe.com/'+id,expires_at:Math.floor(time/1000)+1800};sessions.set(id,result)}
  else if(path.startsWith('checkout/sessions/')){result=sessions.get(path.split('/')[2]);if(path.endsWith('/expire'))result.status='expired'}
  else if(path==='billing_portal/sessions')result={url:'https://billing.stripe.com/session'};
  else throw Error('Unexpected Stripe request '+path);
  return new Response(JSON.stringify(result),{status:200});
 };
 const app=createApp({env,transport,sendMail:async msg=>mails.push(msg),clock:()=>time});
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));app.close()});
 const base='http://127.0.0.1:'+server.address().port;
 async function req(path,data,cookie='',headers={}){const r=await fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:env.APP_ORIGIN,Cookie:cookie,...headers},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
 async function login(email){assert.equal((await req('auth/request',{email})).status,200);const token=new URL(mails.at(-1).link).hash.slice(7);const result=await req('auth/verify',{token});assert.equal(result.status,200);assert.equal((await req('auth/verify',{token})).status,400);return result.cookie}
 async function webhook(sub,eventId){const body=JSON.stringify({id:eventId||'evt_'+ ++eventCount,type:'customer.subscription.updated',data:{object:{id:sub.id}}}),ts=Math.floor(time/1000),sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(ts+'.'+body).digest('hex');const r=await fetch(base+'/api/webhook',{method:'POST',headers:{'stripe-signature':`t=${ts},v1=${sig}`},body});assert.equal(r.status,200)}
 assert.equal((await req('config')).data.billingReady,true);
 assert.equal((await req('me')).status,401);
 assert.equal((await req('auth/request',{email:'x@y.test'},'',{Origin:'https://evil.test'})).status,403);
 const owner=await login('owner@example.com'),partner=await login('partner@example.com'),third=await login('third@example.com');
 assert.equal((await req('invite',{},owner)).status,404);
 assert.equal((await req('checkout',{plan:'free',acceptedTerms:true},owner)).status,400);
 assert.equal((await req('checkout',{plan:'yearly',acceptedTerms:false},owner)).status,400);
 assert.equal((await req('checkout',{plan:'yearly',acceptedTerms:true},owner)).status,200);
 assert.equal((await req('checkout',{plan:'yearly',acceptedTerms:true},owner)).status,200);
 assert.equal(checkoutCount,1,'checkout reused to avoid duplicate charges');
 assert.equal((await req('me',undefined,owner)).data.paid,false,'return from checkout is not entitlement');
 const sub={id:'sub_1',customer:customers.get('owner@example.com'),status:'active',items:{data:[{price:{id:'price_year'},current_period_end:Math.floor(time/1000)+365*86400}]}};subscriptions.set(sub.id,sub);sessions.get('cs_1').status='complete';
 await webhook(sub,'evt_initial');await webhook(sub,'evt_initial');
 let state=(await req('me',undefined,owner)).data;assert.equal(state.jar.active,true);
 assert.equal((await req('checkout',{plan:'monthly',acceptedTerms:true},owner)).status,409);
 const first=(await req('invite',{},owner)).data.url;
 const second=(await req('invite',{},owner)).data.url;
 assert.equal((await req('join',{token:new URL(first).hash.slice(8)},partner)).status,400,'old invite revoked');
 assert.equal((await req('join',{token:new URL(second).hash.slice(8)},partner)).status,200);
 assert.equal((await req('join',{token:new URL(second).hash.slice(8)},third)).status,400);
 assert.equal((await req('invite',{},partner)).status,403);
 assert.equal((await req('checkout',{plan:'yearly',acceptedTerms:true},partner)).status,409);
 assert.equal((await req('jar/add',{version:0,id:'abcdefghijklmnop'},third)).status,404);
 let a=await req('jar/add',{version:state.jar.version,id:'abcdefghijklmnop'},owner);assert.equal(a.status,200);
 let conflict=await req('jar/add',{version:state.jar.version,id:'qrstuvwxyzabcdef'},partner);assert.equal(conflict.status,409);
 state=(await req('me',undefined,partner)).data;assert.equal(state.jar.history.length,1);
 a=await req('jar/add',{version:state.jar.version,id:'qrstuvwxyzabcdef'},partner);assert.equal(a.status,200);
 a=await req('jar/undo',{version:a.data.jar.version,id:a.data.jar.history.at(-1).id},owner);assert.equal(a.status,200);assert.equal(a.data.jar.history.length,1);
 assert.equal((await req('jar/import',{version:a.data.jar.version,history:[{ts:time}]},owner)).status,409);
 a=await req('jar/name',{version:a.data.jar.version,name:'<img src=x onerror=alert(1)>'},owner);assert.equal(a.status,200);
 assert.equal((await req('export',undefined,partner)).data.jar.name,'<img src=x onerror=alert(1)>');
 time+=366*86400000;
 // Expired sessions do not remain usable.
 assert.equal((await req('me',undefined,owner)).status,401);
 const owner2=await login('owner@example.com'),partner2=await login('partner@example.com');
 state=(await req('me',undefined,owner2)).data;assert.equal(state.jar.active,false);
 assert.equal((await req('jar/add',{version:state.jar.version,id:'1234567890abcdef'},owner2)).status,402);
 assert.equal((await req('export',undefined,partner2)).status,200,'expired pair still can export');
 assert.equal((await req('disconnect',{confirm:true},partner2)).status,200);
 assert.equal((await req('export',undefined,partner2)).data.jar,null);
 sub.items.data[0].current_period_end=Math.floor(time/1000)+365*86400;await webhook(sub);
 state=(await req('me',undefined,owner2)).data;assert.equal(state.jar.active,true);
 const invite=(await req('invite',{},owner2)).data.url;time+=86400001;
 assert.equal((await req('join',{token:new URL(invite).hash.slice(8)},partner2)).status,400,'expired invite denied');
 const invite2=(await req('invite',{},owner2)).data.url;assert.equal((await req('join',{token:new URL(invite2).hash.slice(8)},partner2)).status,200);
 assert.equal((await req('account/delete',{confirm:'DELETE'},owner2)).status,200);
 assert.equal(sub.status,'canceled','subscription cancelled before deleting account');
 assert.equal((await req('me',undefined,owner2)).status,401);
 assert.equal((await req('me',undefined,partner2)).data.jar,null,'partner loses deleted jar access');
});

test('unconfigured installation works locally and fails closed for paid features',async t=>{
 const app=createApp({env:{APP_ORIGIN:'http://localhost:3000'}}),server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));app.close()});
 const base='http://127.0.0.1:'+server.address().port;
 const config=await (await fetch(base+'/api/config')).json();assert.equal(config.billingReady,false);assert.equal(config.authReady,false);
 const r=await fetch(base+'/api/auth/request',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({email:'a@b.test'})});assert.equal(r.status,503);
 assert.equal((await fetch(base+'/couple/')).status,200);
 assert.equal((await fetch(base+'/server/app.mjs')).status,404);
});
