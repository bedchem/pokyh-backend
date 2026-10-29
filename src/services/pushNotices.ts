import type { ApnsAlert } from './apns';

// One notification, as the website's push and the iOS app's APNs each want it.
// The web texts stay German as they always were; the app gets string keys
// (Localizable.xcstrings in POKYH_IOS) and shows them in the phone's language.

export interface WebPushPayload {
  title: string;
  body: string;
  url: string;
}

export interface PushNotice {
  web: WebPushPayload;
  apns: ApnsAlert;
  // Same id replaces the earlier notification on the phone instead of stacking.
  collapseId?: string;
}

export function newMessagesNotice(count: number): PushNotice {
  const title = count === 1 ? 'Neue Mitteilung' : `${count} neue Mitteilungen`;
  const body = 'Tippe um sie zu sehen';
  return {
    web: { title, body, url: '/messages' },
    apns: {
      title,
      titleKey: count === 1 ? 'push.messages.new.one' : 'push.messages.new.other',
      titleArgs: [String(count)],
      body,
      bodyKey: 'push.tapToOpen',
      thread: 'messages',
      url: '/messages',
    },
    collapseId: 'messages',
  };
}

export function todoDueNotice(todo: { id: string; title: string }): PushNotice {
  const body = 'Tippe um es zu sehen';
  return {
    web: { title: `Todo fällig: ${todo.title}`, body, url: '/todos' },
    apns: {
      title: `Todo fällig: ${todo.title}`,
      titleKey: 'push.todo.due',
      titleArgs: [todo.title],
      body,
      bodyKey: 'push.tapToOpen',
      thread: 'todos',
      url: `/todos/${todo.id}`,
    },
    collapseId: `todo-${todo.id}`,
  };
}

export function reminderNotice(reminder: { id: string; title: string; body?: string | null }): PushNotice {
  const text = reminder.body?.trim() || '';
  const body = text || 'Tippe um sie zu sehen';
  return {
    web: { title: `Erinnerung: ${reminder.title}`, body, url: '/reminders' },
    apns: {
      title: `Erinnerung: ${reminder.title}`,
      titleKey: 'push.reminder',
      titleArgs: [reminder.title],
      body,
      // The class wrote the text themselves, so it goes out as is.
      ...(text ? {} : { bodyKey: 'push.tapToOpen' }),
      thread: 'reminders',
      url: `/reminders/${reminder.id}`,
    },
    collapseId: `reminder-${reminder.id}`,
  };
}
