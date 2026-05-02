import { config } from '../config';

export interface WebUntisResult {
  studentId: number;
  klasseId: number;
  klasseName: string;
}

export async function validateWebUntis(
  username: string,
  password: string
): Promise<WebUntisResult> {
  const base = config.webuntisBase;
  const school = config.webuntisSchool;

  // 1. JSON-RPC authenticate
  const rpcRes = await fetch(`${base}/jsonrpc.do?school=${school}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'pokyh-backend',
      method: 'authenticate',
      params: { user: username, password, client: 'pokyh' },
      jsonrpc: '2.0',
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!rpcRes.ok) {
    throw new Error(`WebUntis returned HTTP ${rpcRes.status}`);
  }

  const rawCookie = rpcRes.headers.get('set-cookie') ?? '';
  const sessionMatch = rawCookie.match(/JSESSIONID=([^;]+)/);
  const sessionId = sessionMatch?.[1] ?? '';

  const rpcJson = (await rpcRes.json()) as {
    result?: { personId: number; klasseId: number };
    error?: { message: string };
  };

  if (rpcJson.error) {
    throw new Error(rpcJson.error.message ?? 'WebUntis authentication failed');
  }

  if (!rpcJson.result) {
    throw new Error('WebUntis returned no result');
  }

  const { personId: studentId, klasseId } = rpcJson.result;
  const cookie = `JSESSIONID=${sessionId}; schoolname="_bGJzLWJyaXhlbg=="`;

  // 2. Fetch class name
  const klassenRes = await fetch(`${base}/jsonrpc.do?school=${school}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: 'pokyh-klassen',
      method: 'getKlassen',
      params: {},
      jsonrpc: '2.0',
    }),
    signal: AbortSignal.timeout(10000),
  });

  let klasseName = '';
  if (klassenRes.ok) {
    const klassenJson = (await klassenRes.json()) as {
      result?: Array<{ id: number; name: string }>;
    };
    klasseName =
      klassenJson.result?.find((k) => k.id === klasseId)?.name ?? '';
  }

  return { studentId, klasseId, klasseName };
}
