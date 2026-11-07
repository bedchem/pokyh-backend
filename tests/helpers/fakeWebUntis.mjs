import { randomBytes } from 'node:crypto';
import http from 'node:http';

// A stand-in WebUntis for the end-to-end suites: just the requests POKYH's
// sign-in sends, answered the way a real instance does. A backend started with
// NODE_ENV=test and WEBUNTIS_TEST_BASE=<fake.base> uses it for every school
// (src/webuntis/schools.ts); outside a test run the backend refuses that
// variable.
//
//   const fake = new FakeWebUntis();
//   await fake.start();
//   fake.account('anna', { personId: 12, klasseId: 4711 });   // a pupil
//   const sessionId = fake.session('anna');                   // as the app holds it
//
// Kinds of account: 'student' (default), 'parent' (own guardian account:
// person type 12, its children in the app-data), 'parent-on-record' (a
// parent's login on the child's record: person type 5, tagged), 'teacher'.

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export class FakeWebUntis {
  constructor({ tenantId = '1000100' } = {}) {
    this.tenantId = tenantId;
    this.accounts = new Map();
    this.sessions = new Map();
    // Person numbers are handed out once each: a redefined account keeps its own.
    this.nextPersonId = 100;
    this.klassen = [
      { id: 4711, name: '4A', longName: '4. Klasse A' },
      { id: 4712, name: '4B', longName: '4. Klasse B' },
      { id: 101, name: '4AHIT', longName: '4AHIT' },
      { id: 202, name: '5BHIT', longName: '5BHIT' },
    ];
    /** true: every request is answered 503, as when WebUntis is down. */
    this.down = false;
    /** Requests seen, by path (and JSON-RPC method), for assertions. */
    this.calls = [];
    /**
     * A suite's own answers, asked first: (req, res, path) => true when it
     * answered (e.g. the message list the push poller reads).
     */
    this.extra = [];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}/WebUntis`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  /**
   * Defines (or redefines) an account. Options: kind, personId, klasseId,
   * password, tenantId, appLoginName (null: the app-data shows no login name),
   * tokenName (null: the bearer token names no login, only the person's number),
   * children (a guardian's: person ids), pageConfig (the pupil's own element
   * carries the class), lessons (the class ids of each weekly lesson),
   * pickerClasses (the timetable picker's classes), authenticateClass
   * (false: authenticate answers klasseId 0).
   */
  account(username, options = {}) {
    const kind = options.kind ?? 'student';
    const previous = this.accounts.get(username);
    const account = {
      username,
      kind,
      password: options.password ?? 'passwort',
      personId: options.personId ?? previous?.personId ?? this.nextPersonId++,
      klasseId: options.klasseId ?? 0,
      tenantId: options.tenantId ?? this.tenantId,
      appLoginName: options.appLoginName === undefined ? username : options.appLoginName,
      // The login name the bearer token carries (`sub`); null: none.
      tokenName: options.tokenName === undefined ? username : options.tokenName,
      children: options.children ?? (kind === 'parent' ? [900 + this.nextPersonId] : []),
      pageConfig: options.pageConfig ?? false,
      lessons: options.lessons ?? null,
      pickerClasses: options.pickerClasses ?? null,
      authenticateClass: options.authenticateClass ?? true,
    };
    // A class the account is in is one of the school's classes.
    if (account.klasseId > 0 && !this.klassen.some((k) => k.id === account.klasseId)) {
      const name = options.klasseName ?? `K${account.klasseId}`;
      this.klassen.push({ id: account.klasseId, name, longName: name });
    }
    this.accounts.set(username, account);
    return account;
  }

  /** A WebUntis session of the account, as the app (or a stolen cookie) holds it. */
  session(username) {
    if (!this.accounts.has(username)) this.account(username);
    const id = `FAKE${randomBytes(12).toString('hex').toUpperCase()}`;
    this.sessions.set(id, username);
    return id;
  }

  endSession(id) {
    this.sessions.delete(id);
  }

  personType(account) {
    return account.kind === 'parent' ? 12 : account.kind === 'teacher' ? 2 : 5;
  }

  sessionAccount(req) {
    const id = /JSESSIONID=([^;\s]+)/.exec(req.headers.cookie ?? '')?.[1];
    const username = id ? this.sessions.get(id) : undefined;
    return username ? this.accounts.get(username) : undefined;
  }

  appData(account) {
    const user = {
      ...(account.appLoginName ? { name: account.appLoginName } : {}),
      person: { id: account.personId, displayName: account.username },
      roles: [account.kind === 'parent' ? 'LEGAL_GUARDIAN' : account.kind === 'teacher' ? 'TEACHER' : 'STUDENT'],
      ...(account.kind === 'parent-on-record' ? { tags: ['Elternaccount'] } : {}),
      students: account.children.map((id) => ({ id, displayName: `Kind ${id}` })),
    };
    return { user };
  }

  handle(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const json = (status, value, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
      if (this.down) { res.writeHead(503).end('down'); return; }
      const account = this.sessionAccount(req);
      const p = url.pathname.replace(/^\/WebUntis/, '');
      for (const handler of this.extra) if (handler(req, res, p, body)) return;

      if (p === '/jsonrpc.do') {
        let rpc = {};
        try { rpc = JSON.parse(body || '{}'); } catch { /* answered below */ }
        this.calls.push(`rpc:${rpc.method}`);
        const reply = (result, headers) => json(200, { jsonrpc: '2.0', id: rpc.id, result }, headers);
        const fail = (code, message) => json(200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });
        if (rpc.method === 'authenticate') {
          const a = this.accounts.get(String(rpc.params?.user ?? '').toLowerCase());
          if (!a || rpc.params?.password !== a.password) return fail(-8504, 'bad credentials');
          const id = this.session(a.username);
          return reply({ sessionId: id, personType: this.personType(a), personId: a.personId, klasseId: a.authenticateClass ? a.klasseId : 0 },
            { 'set-cookie': `JSESSIONID=${id}; Path=/WebUntis` });
        }
        if (!account) return fail(-8520, 'not authenticated');
        if (rpc.method === 'getKlassen') return reply(this.klassen);
        if (rpc.method === 'getStudents') return fail(-8509, 'no right');
        if (rpc.method === 'getCurrentSchoolyear') return reply({ id: 1, name: '2026/2027' });
        if (rpc.method === 'getLatestImportTime') return reply(Date.now());
        if (rpc.method === 'getHolidays') return reply([]);
        return reply([]);
      }

      this.calls.push(p);
      if (p === '/api/token/new') {
        if (!account) { res.writeHead(401).end(''); return; }
        const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
          tenant_id: account.tenantId, ...(account.tokenName ? { sub: account.tokenName } : { sub: String(account.personId) }), roles: account.kind.toUpperCase(),
          exp: Math.floor(Date.now() / 1000) + 900,
        })}.c2lnbmF0dXJl`;
        res.writeHead(200, { 'content-type': 'text/plain' }).end(token);
        return;
      }
      if (!account) { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>'); return; }
      if (p === '/api/rest/view/v1/app/data') return json(200, this.appData(account));
      if (p === '/api/public/timetable/weekly/pageconfig') {
        const elements = account.pageConfig ? [{ type: 5, id: account.personId, name: account.username, klasseId: account.klasseId }] : [];
        return json(200, { data: { elements } });
      }
      if (p === '/api/public/timetable/weekly/data') {
        const lessons = account.lessons ?? [];
        const ids = [...new Set(lessons.flat())];
        return json(200, { data: { result: { data: {
          elementIds: [account.personId],
          elementPeriods: { [account.personId]: lessons.map((classIds, i) => ({ id: i + 1, elements: classIds.map((id) => ({ type: 1, id })) })) },
          elements: this.klassen.filter((k) => ids.includes(k.id)).map((k) => ({ type: 1, id: k.id, name: k.name, longName: k.longName })),
        } } } });
      }
      if (p === '/api/rest/view/v1/timetable/entries') return json(200, { days: [] });
      if (p === '/api/rest/view/v1/timetable/filter') {
        const classes = (account.pickerClasses ?? []).map((id) => this.klassen.find((k) => k.id === id)).filter(Boolean)
          .map((k) => ({ class: { id: k.id, shortName: k.name, longName: k.longName } }));
        return json(200, { classes });
      }
      json(404, { error: 'not here' });
    });
  }
}
