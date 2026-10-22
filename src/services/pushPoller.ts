import webpush from 'web-push';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { config } from '../config';
import { schoolById, schoolOfUser } from './schools';
import { schoolLoginName } from '../webuntis/schools';

const POLL_INTERVAL_MS = config.pushPollIntervalMs;
const DUE_CHECK_INTERVAL_MS = config.pushDueCheckIntervalMs;
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

async function sendPush(sub: PushSub, payload: { title: string; body: string; url: string }) {
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

// The WebUntis server and login name of the subscriber's school: the school
// the account signed in with (schools.webuntis_base / webuntis_school), the
// installation's default for accounts from before schools existed.
async function webuntisOf(stableUid: string): Promise<{ base: string; schoolCookie: string }> {
  const school = await schoolById(await schoolOfUser(stableUid));
  const base = (school?.webuntisBase || config.webuntisBase).replace(/\/$/, '');
  const loginName = school?.webuntisSchool || schoolLoginName(null);
  return { base, schoolCookie: '_' + Buffer.from(loginName).toString('base64') };
}

async function pollSubscription(sub: PushSub) {
  if (!sub.jsessionid) return;

  try {
    const { base, schoolCookie } = await webuntisOf(sub.stableUid);
    const res = await fetch(
      `${base}/api/rest/view/v1/messages?pageSize=100&start=0`,
      {
        headers: {
          Cookie: `JSESSIONID=${sub.jsessionid}; schoolname="${schoolCookie}"`,
          Accept: 'application/json',
          ...(sub.bearerToken ? { Authorization: `Bearer ${sub.bearerToken}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (res.status === 401 || res.status === 403) {
      // WebUntis session expired — reset so we don't spam on re-register
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { knownUnread: -1 } });
      return;
    }

    const text = await res.text();
    if (!res.ok || text.trimStart().startsWith('<')) return;

    const json = JSON.parse(text) as Record<string, unknown>;
    const arr =
      (json.incomingMessages as unknown[]) ??
      (json.messages as unknown[]) ??
      ((json.data as { incomingMessages?: unknown[] } | undefined)?.incomingMessages) ??
      [];

    const unread = (arr as Record<string, unknown>[]).filter((m) => {
      const r = m['isRead'] ?? m['read'];
      if (typeof r === 'boolean') return !r;
      if (typeof r === 'number') return r !== 1;
      return false;
    }).length;

    if (sub.knownUnread >= 0 && unread > sub.knownUnread) {
      const diff = unread - sub.knownUnread;
      await sendPush(sub, {
        title: diff === 1 ? 'Neue Mitteilung' : `${diff} neue Mitteilungen`,
        body: 'Tippe um sie zu sehen',
        url: '/messages',
      });
    }

    await prisma.pushSubscription.update({ where: { id: sub.id }, data: { knownUnread: unread } });
  } catch (err) {
    logger.warn(`[push] Poll error for ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Which node handles a subscription or a due item. On a standalone server
// always this one; in a cluster each item belongs to one reachable node.
type Owns = (key: string) => boolean;

async function pollAll(owns: Owns) {
  const subs = (await prisma.pushSubscription.findMany()).filter((sub) => owns(`push-sub:${sub.id}`));
  if (subs.length === 0) return;
  logger.debug(`[push] Polling ${subs.length} subscriptions`);
  await Promise.allSettled(subs.map(pollSubscription));
}

async function sendPushToUser(stableUid: string, payload: { title: string; body: string; url: string }) {
  const subs = await prisma.pushSubscription.findMany({ where: { stableUid } });
  await Promise.allSettled(subs.map((sub) => sendPush(sub, payload)));
}

async function checkDueItems(owns: Owns) {
  const now = new Date();

  const dueTodos = (await prisma.todo.findMany({
    where: { dueAt: { lte: now }, notifiedAt: null, done: false, archivedAt: null },
  })).filter((todo) => owns(`todo:${todo.id}`));

  for (const todo of dueTodos) {
    await sendPushToUser(todo.stableUid, {
      title: `Todo fällig: ${todo.title}`,
      body: 'Tippe um es zu sehen',
      url: '/todos',
    });
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
    await Promise.allSettled(
      memberUids.map((uid) =>
        sendPushToUser(uid, {
          title: `Erinnerung: ${reminder.title}`,
          body: reminder.body || 'Tippe um sie zu sehen',
          url: '/reminders',
        }),
      ),
    );
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

// `owns` shares the work out in a cluster: every subscription and every due
// item is handled by exactly one of the reachable nodes, so a notification is
// not sent once per node and the WebUntis polling is spread over all of them.
export function startPushPoller(owns: Owns = () => true) {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    logger.info('[push] VAPID keys not set — push notifications disabled');
    return;
  }

  try {
    webpush.setVapidDetails(
      `mailto:${config.vapidEmail}`,
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
  } catch (err) {
    logger.error(`[push] VAPID configuration rejected — push notifications disabled: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  runSafely('message poll', () => pollAll(owns));
  setInterval(() => runSafely('message poll', () => pollAll(owns)), POLL_INTERVAL_MS);

  runSafely('due-item check', () => checkDueItems(owns));
  setInterval(() => runSafely('due-item check', () => checkDueItems(owns)), DUE_CHECK_INTERVAL_MS);

  logger.info('[push] Poller started (messages: 5 min, due items: 1 min)');
}
