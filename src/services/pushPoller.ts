import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { config } from '../config';
import { schoolById, schoolOfUser } from './schools';
import { schoolLoginName } from '../webuntis/schools';
import { ApnsClient, isEnvironment } from './apns';
import { newMessagesNotice, reminderNotice, todoDueNotice, type PushNotice, type WebPushPayload } from './pushNotices';

const POLL_INTERVAL_MS = config.pushPollIntervalMs;
const DUE_CHECK_INTERVAL_MS = config.pushDueCheckIntervalMs;

// Set by startPushPoller: web push needs VAPID keys, APNs its .p8 key.
let webEnabled = false;
let apns: ApnsClient | null = null;

interface PushSub {
  id: string;
  stableUid: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  jsessionid: string;
  bearerToken: string;
  knownUnread: number;
}

interface ApnsTarget {
  id: string;
  token: string;
  environment: string;
}

// What the message poll needs, whichever kind of push it ends up as.
interface PollTarget {
  id: string;
  stableUid: string;
  jsessionid: string;
  bearerToken: string;
  knownUnread: number;
}

async function sendWebPush(sub: PushSub, payload: WebPushPayload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
  } catch (err: unknown) {
    // 410 Gone = subscription expired (user uninstalled or browser cleared it)
    if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
    } else {
      logger.warn(`[push] Send failed for ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function sendApns(device: ApnsTarget, notice: PushNotice) {
  if (!apns || !isEnvironment(device.environment)) return;
  const outcome = await apns.send({ token: device.token, environment: device.environment }, notice.apns, notice.collapseId);
  if (outcome.kind === 'sent') return;
  if (outcome.kind === 'gone') {
    // App deleted or notifications turned off for good.
    await prisma.apnsDevice.delete({ where: { id: device.id } }).catch(() => {});
    return;
  }
  logger.warn(`[push] APNs send failed for ${device.id}: ${outcome.reason}`);
}

// Devices whose device session was signed out don't get anything any more.
async function liveApnsDevices(where: { stableUid?: string } = {}) {
  const devices = await prisma.apnsDevice.findMany({ where, include: { session: { select: { revokedAt: true } } } });
  const revoked = devices.filter((d) => d.session?.revokedAt);
  if (revoked.length > 0) {
    await prisma.apnsDevice.deleteMany({ where: { id: { in: revoked.map((d) => d.id) } } }).catch(() => {});
  }
  return devices.filter((d) => !d.session?.revokedAt);
}

// The WebUntis server and login name of the subscriber's school: the school
// the account signed in with (schools.webuntis_base / webuntis_school), the
// installation's default for accounts from before schools existed.
async function webuntisOf(stableUid: string): Promise<{ base: string; schoolCookie: string }> {
  const school = await schoolById(await schoolOfUser(stableUid));
  const base = (school?.webuntisBase || config.webuntisBase).replace(/\/$/, '');
  const loginName = school?.webuntisSchool || schoolLoginName(null);
  return { base, schoolCookie: '_' + Buffer.from(loginName).toString('base64') };
}

// Unread WebUntis messages; 'expired' when the session is gone, null when
// WebUntis answered with something we can't read.
async function unreadMessages(target: PollTarget): Promise<number | 'expired' | null> {
  const { base, schoolCookie } = await webuntisOf(target.stableUid);
  const res = await fetch(
    `${base}/api/rest/view/v1/messages?pageSize=100&start=0`,
    {
      headers: {
        Cookie: `JSESSIONID=${target.jsessionid}; schoolname="${schoolCookie}"`,
        Accept: 'application/json',
        ...(target.bearerToken ? { Authorization: `Bearer ${target.bearerToken}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    },
  );

  if (res.status === 401 || res.status === 403) return 'expired';

  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith('<')) return null;

  const json = JSON.parse(text) as Record<string, unknown>;
  const arr =
    (json.incomingMessages as unknown[]) ??
    (json.messages as unknown[]) ??
    ((json.data as { incomingMessages?: unknown[] } | undefined)?.incomingMessages) ??
    [];

  return (arr as Record<string, unknown>[]).filter((m) => {
    const r = m['isRead'] ?? m['read'];
    if (typeof r === 'boolean') return !r;
    if (typeof r === 'number') return r !== 1;
    return false;
  }).length;
}

async function pollTarget(
  target: PollTarget,
  setUnread: (unread: number) => Promise<unknown>,
  notify: (notice: PushNotice) => Promise<void>,
) {
  if (!target.jsessionid) return;

  try {
    const unread = await unreadMessages(target);
    if (unread === 'expired') {
      // WebUntis session expired — reset so we don't spam on re-register
      await setUnread(-1);
      return;
    }
    if (unread === null) return;

    if (target.knownUnread >= 0 && unread > target.knownUnread) {
      await notify(newMessagesNotice(unread - target.knownUnread));
    }
    await setUnread(unread);
  } catch (err) {
    logger.warn(`[push] Poll error for ${target.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Which node handles a subscription or a due item. On a standalone server
// always this one; in a cluster each item belongs to one reachable node.
type Owns = (key: string) => boolean;

async function pollAll(owns: Owns) {
  const subs = webEnabled
    ? (await prisma.pushSubscription.findMany()).filter((sub) => owns(`push-sub:${sub.id}`))
    : [];
  const devices = apns
    ? (await liveApnsDevices()).filter((device) => owns(`apns:${device.id}`))
    : [];
  if (subs.length === 0 && devices.length === 0) return;
  logger.debug(`[push] Polling ${subs.length} web subscriptions, ${devices.length} APNs devices`);
  await Promise.allSettled([
    ...subs.map((sub) => pollTarget(
      sub,
      (knownUnread) => prisma.pushSubscription.update({ where: { id: sub.id }, data: { knownUnread } }),
      (notice) => sendWebPush(sub, notice.web),
    )),
    ...devices.map((device) => pollTarget(
      device,
      (knownUnread) => prisma.apnsDevice.update({ where: { id: device.id }, data: { knownUnread } }),
      (notice) => sendApns(device, notice),
    )),
  ]);
}

async function sendPushToUser(stableUid: string, notice: PushNotice) {
  const [subs, devices] = await Promise.all([
    webEnabled ? prisma.pushSubscription.findMany({ where: { stableUid } }) : Promise.resolve([]),
    apns ? liveApnsDevices({ stableUid }) : Promise.resolve([]),
  ]);
  await Promise.allSettled([
    ...subs.map((sub) => sendWebPush(sub, notice.web)),
    ...devices.map((device) => sendApns(device, notice)),
  ]);
}

async function checkDueItems(owns: Owns) {
  const now = new Date();

  const dueTodos = (await prisma.todo.findMany({
    where: { dueAt: { lte: now }, notifiedAt: null, done: false, archivedAt: null },
  })).filter((todo) => owns(`todo:${todo.id}`));

  for (const todo of dueTodos) {
    await sendPushToUser(todo.stableUid, todoDueNotice(todo));
    await prisma.todo.update({ where: { id: todo.id }, data: { notifiedAt: now } });
    logger.debug(`[push] Todo due notification sent: ${todo.id}`);
  }

  const dueReminders = (await prisma.reminder.findMany({
    where: { remindAt: { lte: now }, notifiedAt: null, archivedAt: null },
    include: { class: { include: { members: true } } },
  })).filter((reminder) => owns(`reminder:${reminder.id}`));

  for (const reminder of dueReminders) {
    // Parents have no reminders — never notify them.
    const memberUids = reminder.class.members
      .filter((m) => m.role !== 'parent')
      .map((m) => m.stableUid);
    const notice = reminderNotice(reminder);
    await Promise.allSettled(memberUids.map((uid) => sendPushToUser(uid, notice)));
    await prisma.reminder.update({ where: { id: reminder.id }, data: { notifiedAt: now } });
    logger.debug(`[push] Reminder notification sent: ${reminder.id} to ${memberUids.length} members`);
  }
}

// A poll or due-item pass that fails (database briefly unavailable, WebUntis
// unreachable) must only skip that pass. Left unhandled, the rejection would
// take the whole API process down.
function runSafely(name: string, job: () => Promise<void>): void {
  job().catch((err) => {
    logger.warn(`[push] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function setUpWebPush(): boolean {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    logger.info('[push] VAPID keys not set — web push disabled');
    return false;
  }
  try {
    webpush.setVapidDetails(
      `mailto:${config.vapidEmail}`,
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
    return true;
  } catch (err) {
    logger.error(`[push] VAPID configuration rejected — web push disabled: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function setUpApns(): ApnsClient | null {
  const { apnsKeyId, apnsTeamId, apnsTopic, apnsKeyPath } = config;
  if (!apnsKeyId || !apnsTeamId || !apnsTopic || (!config.apnsKey && !apnsKeyPath)) {
    logger.info('[push] APNs not configured — iOS push disabled');
    return null;
  }
  try {
    const key = config.apnsKey || readFileSync(apnsKeyPath, 'utf8');
    return new ApnsClient({
      keyId: apnsKeyId,
      teamId: apnsTeamId,
      key,
      topic: apnsTopic,
      hosts: { sandbox: config.apnsHostSandbox, production: config.apnsHostProduction },
      timeoutMs: config.apnsTimeoutMs,
      tokenTtlMs: config.apnsTokenTtlMs,
    });
  } catch (err) {
    logger.error(`[push] APNs key rejected — iOS push disabled: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// `owns` shares the work out in a cluster: every subscription and every due
// item is handled by exactly one of the reachable nodes, so a notification is
// not sent once per node and the WebUntis polling is spread over all of them.
export function startPushPoller(owns: Owns = () => true) {
  webEnabled = setUpWebPush();
  apns = setUpApns();
  if (!webEnabled && !apns) {
    logger.info('[push] No push channel configured — push notifications disabled');
    return;
  }

  runSafely('message poll', () => pollAll(owns));
  setInterval(() => runSafely('message poll', () => pollAll(owns)), POLL_INTERVAL_MS);

  runSafely('due-item check', () => checkDueItems(owns));
  setInterval(() => runSafely('due-item check', () => checkDueItems(owns)), DUE_CHECK_INTERVAL_MS);

  const channels = [webEnabled && 'web', apns && 'APNs'].filter(Boolean).join(' + ');
  logger.info(`[push] Poller started for ${channels} (messages every ${POLL_INTERVAL_MS / 1000}s, due items every ${DUE_CHECK_INTERVAL_MS / 1000}s)`);
}
