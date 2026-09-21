import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../couple/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (status, message) => {throw Object.assign(new Error(message), {status})};
const day = 86400000;

export function verifySignature(body, signature, secret, now = Date.now()) {
  if (!secret || typeof signature !== 'string') return false;
  const parts = signature.split(',').map(p => p.split('='));
  const t = parts.find(p => p[0] === 't')?.[1];
  if (!/^\d+$/.test(t || '') || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return parts.filter(p => p[0] === 'v1').some(([,v]) => /^[a-f0-9]{64}$/i.test(v) && timingSafeEqual(expected, Buffer.from(v, 'hex')));
}

export function createApp({database = ':memory:', env = process.env, transport = fetch, sendMail, clock = Date.now} = {}) {
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,customer TEXT UNIQUE,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_tokens(hash TEXT PRIMARY KEY,email TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,owner TEXT REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL,until_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jars(id TEXT PRIMARY KEY,owner TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,jar_id TEXT REFERENCES jars(id) ON DELETE CASCADE,role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,jar_id TEXT REFERENCES jars(id) ON DELETE CASCADE,author TEXT,ts INTEGER NOT NULL,voided INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS entries_jar ON entries(jar_id,voided,ts);
    CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,jar_id TEXT REFERENCES jars(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS checkouts(owner TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,session_id TEXT,plan TEXT,url TEXT,expires INTEGER);
    CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_ms INTEGER NOT NULL);`);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => {db.exec('BEGIN IMMEDIATE');try {const result = fn();db.exec('COMMIT');return result} catch (e) {db.exec('ROLLBACK');throw e}};
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:3000').origin;
  const secure = origin.startsWith('https:');
  const authReady = !!(sendMail || (env.RESEND_API_KEY && env.MAIL_FROM));
  const legalReady = ['TERMS_URL','PRIVACY_URL','IMPRINT_URL'].every(k => /^https:\/\//.test(env[k] || ''));
  const billingReady = authReady && legalReady && !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_YEARLY) && (secure || !env.STRIPE_SECRET_KEY.startsWith('sk_live_'));
  const cookie = (value, seconds = 30 * 86400) => `gnj_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const entitled = owner => !!get("SELECT id FROM subscriptions WHERE owner=? AND status='active' AND until_ms>?", owner, clock());
  const member = user => get('SELECT j.*,m.role FROM members m JOIN jars j ON j.id=m.jar_id WHERE m.user_id=?', user.id);
  const snapshot = user => {
    const j = member(user);
    return {user:{email:user.email}, paid:entitled(user.id), jar:j ? {id:j.id,name:j.name,version:j.version,role:j.role,active:entitled(j.owner),partnerConnected:!!get("SELECT user_id FROM members WHERE jar_id=? AND role='partner'",j.id),history:all('SELECT id,ts FROM entries WHERE jar_id=? AND voided=0 ORDER BY ts,id',j.id)} : null};
  };
  function rate(key, limit, window) {
    const time = clock();
    run('DELETE FROM rate_limits WHERE until_ms<?',time);
    const row = get('SELECT * FROM rate_limits WHERE key=?',key);
    if (row && row.count >= limit) fail(429,'Zu viele Versuche. Bitte später erneut versuchen.');
    if (row) run('UPDATE rate_limits SET count=count+1 WHERE key=?',key);
    else run('INSERT INTO rate_limits VALUES(?,1,?)',key,time+window);
  }
  async function stripe(path, fields, method = 'POST', idempotency) {
    const response = await transport('https://api.stripe.com/v1/'+path, {
      method:fields === undefined && method === 'POST' ? 'GET' : method,
      headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version':'2025-06-30.basil', ...(fields ? {'Content-Type':'application/x-www-form-urlencoded'} : {}), ...(idempotency ? {'Idempotency-Key':idempotency} : {})},
      body:fields ? new URLSearchParams(fields).toString() : undefined,
      signal:AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) fail(502,'Zahlungsdienst vorübergehend nicht erreichbar. Bitte erneut versuchen.');
    return data;
  }
  async function refreshSubscription(id) {
    const sub = await stripe('subscriptions/'+encodeURIComponent(id));
    const user = get('SELECT * FROM users WHERE customer=?',typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
    if (!user) return;
    const item = sub.items?.data?.find(i => [env.STRIPE_PRICE_MONTHLY,env.STRIPE_PRICE_YEARLY].includes(i.price?.id));
    const until = Number(item?.current_period_end || sub.current_period_end || 0)*1000;
    const status = item ? sub.status : 'unpaid';
    transaction(() => {
      run('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,until_ms=excluded.until_ms',sub.id,user.id,status,until);
      if (status === 'active' && until > clock() && !member(user)) {
        const id = randomUUID();run('INSERT INTO jars(id,owner) VALUES(?,?)',id,user.id);
        run("INSERT INTO members VALUES(?,?,'owner')",user.id,id);
      }
    });
  }
  const locks = new Map();
  async function exclusive(key, fn) {
    if (locks.has(key)) fail(409,'Dieser Vorgang läuft bereits. Bitte kurz warten.');
    locks.set(key,true);try{return await fn()}finally{locks.delete(key)}
  }
  async function bodyOf(req) {
    let size = 0;const parts = [];
    for await (const part of req) {size += part.length;if(size > 1024*1024) fail(413,'Datei zu groß.');parts.push(part)}
    return Buffer.concat(parts).toString('utf8');
  }
  function currentUser(req) {
    const value = /(?:^|;\s*)gnj_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const row = value && get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?',hash(value),clock());
    if (!row) fail(401,'Bitte anmelden.');return row;
  }
  function requireJar(user, writable = false) {
    const j = member(user);if (!j) fail(404,'Noch kein gemeinsames Glas.');
    if (writable && !entitled(j.owner)) fail(402,'Together ist abgelaufen. Eure Daten bleiben lesbar und exportierbar.');return j;
  }
  function mutate(user, data, fn) {
    return transaction(() => {
      const j = requireJar(user,true);
      if (!Number.isSafeInteger(data.version) || j.version !== data.version) fail(409,'Das Glas wurde inzwischen geändert. Bitte erneut versuchen.');
      fn(j);run('UPDATE jars SET version=version+1 WHERE id=?',j.id);return snapshot(user);
    });
  }
  async function handle(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const reply = (data, status = 200) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
    try {
      const url = new URL(req.url,origin), path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(req.method)) fail(405,'Methode nicht erlaubt.');
        const filename = path === '/' || path === '/couple' || path === '/couple/' ? 'index.html' : path.replace(/^\/couple\//,'').replace(/^\//,'');
        const types = {'index.html':'text/html','app.js':'text/javascript','styles.css':'text/css','manifest.webmanifest':'application/manifest+json','service-worker.js':'text/javascript','icon.svg':'image/svg+xml'};
        if (!types[filename]) fail(404,'Nicht gefunden.');
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
        res.writeHead(200,{'Content-Type':types[filename]+'; charset=utf-8','Cache-Control':'no-cache'});
        const bytes = await readFile(root+filename);res.end(req.method === 'HEAD' ? undefined : bytes);return;
      }
      rate('ip:'+hash(req.socket.remoteAddress || 'unknown'),300,60000);
      if (path === '/api/webhook' && req.method === 'POST') {
        const raw = await bodyOf(req);
        if (!verifySignature(raw,req.headers['stripe-signature'],env.STRIPE_WEBHOOK_SECRET,clock())) fail(400,'Ungültige Signatur.');
        const event = JSON.parse(raw);
        if (!event.id || !event.type) fail(400,'Ungültiges Ereignis.');
        if (get('SELECT id FROM webhook_events WHERE id=?',event.id)) return reply({received:true});
        const object = event.data?.object;
        if (event.type.startsWith('customer.subscription.')) await refreshSubscription(object.id);
        if (event.type === 'checkout.session.completed' && object.subscription) await refreshSubscription(typeof object.subscription === 'string' ? object.subscription : object.subscription.id);
        if (['invoice.paid','invoice.payment_failed'].includes(event.type)) {
          const sub = object.subscription || object.parent?.subscription_details?.subscription;
          if (sub) await refreshSubscription(typeof sub === 'string' ? sub : sub.id);
        }
        run('INSERT OR IGNORE INTO webhook_events VALUES(?,?)',event.id,clock());return reply({received:true});
      }
      if (req.method === 'POST' && req.headers.origin !== origin) fail(403,'Ungültige Herkunft.');
      if (!['GET','POST'].includes(req.method)) fail(405,'Methode nicht erlaubt.');
      let data = {};
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON erforderlich.');
        try{data = JSON.parse(await bodyOf(req))}catch(e){if(e.status)throw e;fail(400,'Ungültige Daten.');}
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400,'Ungültige Daten.');
      }
      const route = `${req.method} ${path}`;
      if (route === 'GET /api/config') return reply({authReady,billingReady,testMode:!env.STRIPE_SECRET_KEY?.startsWith('sk_live_'),terms:env.TERMS_URL || null,privacy:env.PRIVACY_URL || null,imprint:env.IMPRINT_URL || null});
      if (route === 'POST /api/auth/request') {
        if (!authReady) fail(503,'Together wird gerade vorbereitet. Du kannst die lokale Version kostenlos nutzen.');
        const email = String(data.email || '').trim().toLowerCase();
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Bitte eine gültige E-Mail-Adresse eingeben.');
        rate('mail:'+hash(email),3,15*60000);rate('send:'+hash(req.socket.remoteAddress || ''),10,15*60000);
        const value = token();run('DELETE FROM login_tokens WHERE expires<?',clock());
        run('INSERT INTO login_tokens VALUES(?,?,?)',hash(value),email,clock()+15*60000);
        const link = `${origin}/couple/#login=${value}`;
        try {
          if (sendMail) await sendMail({email,link});
          else {
            const result = await transport('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.MAIL_FROM,to:[email],subject:'Dein Zugang zu Good Night Jar',text:`Mit diesem Link meldest du dich bei Good Night Jar an. Er gilt 15 Minuten und kann nur einmal verwendet werden.\n\n${link}\n\nFalls du das nicht warst, ignoriere diese Nachricht.`}),signal:AbortSignal.timeout(15000)});
            if (!result.ok) fail(503,'E-Mail konnte gerade nicht versendet werden. Bitte später erneut versuchen.');
          }
        } catch(e) {run('DELETE FROM login_tokens WHERE hash=?',hash(value));throw e}
        return reply({ok:true});
      }
      if (route === 'POST /api/auth/verify') {
        const value = String(data.token || '');if(value.length !== 43) fail(400,'Link ungültig oder abgelaufen.');
        const user = transaction(() => {
          const login = get('SELECT * FROM login_tokens WHERE hash=? AND expires>?',hash(value),clock());
          if (!login) fail(400,'Link ungültig oder abgelaufen.');
          run('DELETE FROM login_tokens WHERE hash=?',hash(value));
          run('INSERT OR IGNORE INTO users(id,email,created) VALUES(?,?,?)',randomUUID(),login.email,clock());
          return get('SELECT * FROM users WHERE email=?',login.email);
        });
        const session = token();run('DELETE FROM sessions WHERE expires<?',clock());run('INSERT INTO sessions VALUES(?,?,?)',hash(session),user.id,clock()+30*day);
        res.setHeader('Set-Cookie',cookie(session));return reply(snapshot(user));
      }
      const user = currentUser(req);
      if (route === 'GET /api/me') return reply(snapshot(user));
      if (route === 'POST /api/auth/logout') {
        const value = /(?:^|;\s*)gnj_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        if(value)run('DELETE FROM sessions WHERE hash=?',hash(value));res.setHeader('Set-Cookie',cookie('',0));return reply({ok:true});
      }
      if (route === 'POST /api/checkout') return await exclusive(user.id,async () => {
        if (!billingReady) fail(503,'Bezahlung ist noch nicht freigeschaltet.');
        if (!['monthly','yearly'].includes(data.plan) || data.acceptedTerms !== true) fail(400,'Bitte Tarif und Bedingungen bestätigen.');
        if (member(user)?.role === 'partner' || entitled(user.id)) fail(409,'Euer Paar hat bereits Together.');
        const existing = get('SELECT * FROM checkouts WHERE owner=?',user.id);
        if (existing?.expires > clock()) return reply({url:existing.url});
        const priceId = data.plan === 'monthly' ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_YEARLY;
        const price = await stripe('prices/'+encodeURIComponent(priceId));
        const expectedAmount = data.plan === 'monthly' ? 299 : 2499;
        if (!price.active || price.currency !== 'eur' || price.unit_amount !== expectedAmount || price.tax_behavior !== 'inclusive' || price.recurring?.interval !== (data.plan === 'monthly' ? 'month' : 'year') || (price.recurring?.interval_count || 1) !== 1) fail(503,'Der Tarif ist noch nicht korrekt eingerichtet.');
        if (!user.customer) {
          const customer = await stripe('customers',{email:user.email,'metadata[gnj_user]':user.id},'POST','gnj-customer-'+user.id);
          run('UPDATE users SET customer=? WHERE id=?',customer.id,user.id);user.customer=customer.id;
        }
        // Reconcile before selling again, including delayed or missed webhooks.
        const subscriptions = await stripe('subscriptions?customer='+encodeURIComponent(user.customer)+'&status=all&limit=100');
        if (subscriptions.data?.some(s => ['active','trialing','past_due','unpaid','incomplete','paused'].includes(s.status))) fail(409,'Es besteht bereits ein Abo. Bitte unter „Abo verwalten“ prüfen.');
        const session = await stripe('checkout/sessions',{mode:'subscription',customer:user.customer,'line_items[0][price]':priceId,'line_items[0][quantity]':'1',success_url:origin+'/couple/?payment=success',cancel_url:origin+'/couple/?payment=cancel',client_reference_id:user.id,'subscription_data[metadata][gnj_user]':user.id,'consent_collection[terms_of_service]':'required','automatic_tax[enabled]':env.STRIPE_AUTOMATIC_TAX === 'true' ? 'true' : 'false','customer_update[address]':'auto',expires_at:String(Math.floor(clock()/1000)+1800)},'POST',`gnj-checkout-${user.id}-${data.plan}-${Math.floor(clock()/1800000)}`);
        run('INSERT INTO checkouts VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET session_id=excluded.session_id,plan=excluded.plan,url=excluded.url,expires=excluded.expires',user.id,session.id,data.plan,session.url,session.expires_at*1000);
        return reply({url:session.url});
      });
      if (route === 'POST /api/portal') {
        if (!user.customer || !billingReady) fail(404,'Noch kein abrechenbares Konto.');
        const session = await stripe('billing_portal/sessions',{customer:user.customer,return_url:origin+'/couple/'});return reply({url:session.url});
      }
      if (route === 'POST /api/billing/refresh') {
        rate('refresh:'+user.id,6,60000);
        if(user.customer && billingReady) {const subs = await stripe('subscriptions?customer='+encodeURIComponent(user.customer)+'&status=all&limit=100');for(const s of subs.data || []) await refreshSubscription(s.id)}
        return reply(snapshot(user));
      }
      if (route === 'POST /api/jar/add') return reply(mutate(user,data,j => {
        if (!/^[a-zA-Z0-9_-]{16,64}$/.test(data.id || '')) fail(400,'Ungültiger Eintrag.');
        if (get('SELECT id FROM entries WHERE id=?',data.id)) fail(409,'Eintrag bereits vorhanden.');
        if(get('SELECT count(*) AS n FROM entries WHERE jar_id=? AND voided=0',j.id).n >= 10000) fail(409,'Bitte exportieren und das Glas leeren.');
        run('INSERT INTO entries(id,jar_id,author,ts) VALUES(?,?,?,?)',data.id,j.id,user.id,clock());
      }));
      if (route === 'POST /api/jar/undo') return reply(mutate(user,data,j => {
        const last = get('SELECT id FROM entries WHERE jar_id=? AND voided=0 ORDER BY ts DESC,id DESC LIMIT 1',j.id);
        if(!last || last.id !== data.id) fail(409,'Der letzte Eintrag hat sich geändert.');
        run('UPDATE entries SET voided=1 WHERE id=?',last.id);
      }));
      if (route === 'POST /api/jar/reset') return reply(mutate(user,data,j => {
        if(data.confirm !== true)fail(400,'Bestätigung erforderlich.');run('UPDATE entries SET voided=1 WHERE jar_id=?',j.id);
      }));
      if (route === 'POST /api/jar/name') return reply(mutate(user,data,j => {
        if(typeof data.name !== 'string' || data.name.length > 40)fail(400,'Name darf maximal 40 Zeichen haben.');run('UPDATE jars SET name=? WHERE id=?',data.name.trim(),j.id);
      }));
      if (route === 'POST /api/jar/import') return reply(mutate(user,data,j => {
        if(get('SELECT id FROM entries WHERE jar_id=? LIMIT 1',j.id))fail(409,'Import ist nur in ein neues gemeinsames Glas möglich.');
        if(!Array.isArray(data.history) || data.history.length > 10000 || !data.history.every(x => Number.isSafeInteger(x.ts) && x.ts >= 0 && x.ts <= clock()))fail(400,'Ungültige Sicherung.');
        for(const entry of data.history)run('INSERT INTO entries(id,jar_id,author,ts) VALUES(?,?,?,?)',randomUUID(),j.id,user.id,entry.ts);
      }));
      if (route === 'POST /api/invite') {
        const j = requireJar(user,true);if(j.role !== 'owner')fail(403,'Nur die Person mit dem Abo kann einladen.');
        if(get("SELECT user_id FROM members WHERE jar_id=? AND role='partner'",j.id))fail(409,'Euer Glas ist bereits verbunden.');
        const value = token();transaction(() => {run('DELETE FROM invites WHERE jar_id=?',j.id);run('INSERT INTO invites VALUES(?,?,?)',hash(value),j.id,clock()+day)});
        return reply({url:origin+'/couple/#invite='+value});
      }
      if (route === 'POST /api/join') return reply(transaction(() => {
        if(member(user))fail(409,'Du bist bereits mit einem Glas verbunden.');
        const invite = get('SELECT * FROM invites WHERE hash=? AND expires>?',hash(String(data.token || '')),clock());
        if(!invite)fail(400,'Einladung ungültig oder abgelaufen.');
        const j = get('SELECT * FROM jars WHERE id=?',invite.jar_id);
        if(!entitled(j.owner))fail(402,'Für dieses Glas ist Together nicht aktiv.');
        if(get("SELECT user_id FROM members WHERE jar_id=? AND role='partner'",j.id))fail(409,'Das Glas ist bereits verbunden.');
        run("INSERT INTO members VALUES(?,?,'partner')",user.id,j.id);run('DELETE FROM invites WHERE jar_id=?',j.id);return snapshot(user);
      }));
      if (route === 'POST /api/disconnect') {
        const j = requireJar(user);if(data.confirm !== true)fail(400,'Bestätigung erforderlich.');
        transaction(() => {run("DELETE FROM members WHERE jar_id=? AND role='partner'",j.id);run('DELETE FROM invites WHERE jar_id=?',j.id);run('UPDATE jars SET version=version+1 WHERE id=?',j.id)});return reply(snapshot(user));
      }
      if (route === 'GET /api/export') return reply({...snapshot(user),exportedAt:new Date(clock()).toISOString()});
      if (route === 'POST /api/account/delete') return await exclusive(user.id,async () => {
        if(data.confirm !== 'DELETE')fail(400,'Bestätigung erforderlich.');
        if(user.customer) {
          // Cancel every subscription before deleting access; failure leaves account recoverable.
          if(!billingReady)fail(503,'Bitte zuerst den Support kontaktieren; Abrechnung ist derzeit nicht erreichbar.');
          const subs = await stripe('subscriptions?customer='+encodeURIComponent(user.customer)+'&status=all&limit=100');
          for(const sub of subs.data || [])if(!['canceled','incomplete_expired'].includes(sub.status))await stripe('subscriptions/'+encodeURIComponent(sub.id),undefined,'DELETE');
          const pending = get('SELECT * FROM checkouts WHERE owner=?',user.id);
          if(pending?.expires > clock()){const checkout=await stripe('checkout/sessions/'+encodeURIComponent(pending.session_id));if(checkout.status==='open')await stripe('checkout/sessions/'+encodeURIComponent(pending.session_id)+'/expire',{});}
        }
        transaction(() => {run('DELETE FROM login_tokens WHERE email=?',user.email);run('UPDATE entries SET author=NULL WHERE author=?',user.id);run('DELETE FROM users WHERE id=?',user.id)});
        res.setHeader('Set-Cookie',cookie('',0));return reply({ok:true});
      });
      fail(404,'Nicht gefunden.');
    } catch(e) {
      if(res.headersSent){res.end();return}
      // Never return tokens, payment provider errors, SQL, or user records.
      reply({error:e.status ? e.message : 'Das hat gerade nicht geklappt. Bitte erneut versuchen.'},e.status || 500);
    }
  }
  return {handle,close:() => db.close()};
}
