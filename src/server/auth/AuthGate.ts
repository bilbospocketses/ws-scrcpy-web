import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from '../db/Db';
import { isAllowlisted, isAuthEnabled, parseCookie, SESSION_COOKIE } from './authState';
import { SessionStore } from './session';

// Minimal, self-contained login page served inline for unauthenticated navigations in locked
// mode. It references NO external bundle/assets (the gated app shell), only an inline script that
// POSTs JSON to /api/auth/login and reloads on success — so it cannot leak the SPA shell and has
// no build dependency. Task 11 (client) may later replace this with a richer page.
const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#1e1e1e;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}form{background:#2a2a2a;padding:2rem;border-radius:8px;width:280px;box-shadow:0 2px 16px #0008}h1{font-size:1.2rem;margin:0 0 1rem}input{display:block;width:100%;box-sizing:border-box;margin:.4rem 0;padding:.55rem;background:#1e1e1e;border:1px solid #444;color:#eee;border-radius:4px}button{width:100%;margin-top:.8rem;padding:.6rem;background:#0078d4;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:1rem}.err{color:#f66;font-size:.85rem;min-height:1.1rem}</style>
</head><body><form id="f"><h1>Sign in</h1>
<input id="u" name="username" placeholder="Username" autocomplete="username" autofocus>
<input id="p" name="password" type="password" placeholder="Password" autocomplete="current-password">
<div class="err" id="e"></div><button type="submit">Sign in</button></form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e');
f.addEventListener('submit',async (ev)=>{ev.preventDefault();e.textContent='';
try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
if(r.ok){location.href='/';}else{e.textContent='Invalid credentials or the account is temporarily locked.';}}catch{e.textContent='Network error — please retry.';}});
</script></body></html>`;

function serveLoginPage(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE_HTML);
}

export class AuthGate {
    constructor(private readonly getDb: () => Db) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const db = this.getDb();
        if (!isAuthEnabled(db)) return false; // open mode → not our concern

        const url = new URL(req.url ?? '/', 'http://localhost');
        if (isAllowlisted(url.pathname)) return false;

        const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
        const session = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
        if (!session) {
            if (url.pathname.startsWith('/api/')) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
            } else {
                // Serve the login page INLINE — never redirect to /login (that would fall through
                // to the static handler's index.html SPA fallback and leak the gated app shell).
                serveLoginPage(res);
            }
            return true; // handled → short-circuit the chain
        }
        (req as IncomingMessage & { user?: unknown }).user = db.users.getById(session.userId);
        return false; // authenticated → let the real handler run
    }
}
