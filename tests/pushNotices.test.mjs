import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { newMessagesNotice, reminderNotice, todoDueNotice, wantsKind } = await loadTs('src/services/pushNotices.ts');

test('the website keeps its German texts', () => {
  assert.deepEqual(newMessagesNotice(1).web, { title: 'Neue Mitteilung', body: 'Tippe um sie zu sehen', url: '/messages' });
  assert.equal(newMessagesNotice(3).web.title, '3 neue Mitteilungen');
  assert.deepEqual(todoDueNotice({ id: 't1', title: 'Mathe' }).web, { title: 'Todo fällig: Mathe', body: 'Tippe um es zu sehen', url: '/todos' });
  assert.deepEqual(reminderNotice({ id: 'r1', title: 'Ausflug', body: null }).web, { title: 'Erinnerung: Ausflug', body: 'Tippe um sie zu sehen', url: '/reminders' });
});

test('new messages: one and many are different keys, grouped and collapsed', () => {
  const one = newMessagesNotice(1);
  const many = newMessagesNotice(4);
  assert.equal(one.apns.titleKey, 'push.messages.new.one');
  assert.equal(many.apns.titleKey, 'push.messages.new.other');
  assert.deepEqual(many.apns.titleArgs, ['4']);
  assert.equal(many.apns.thread, 'messages');
  assert.equal(many.collapseId, 'messages');
});

test('to-dos and reminders open their own detail in the app', () => {
  const todo = todoDueNotice({ id: 't1', title: 'Mathe' });
  assert.equal(todo.apns.url, '/todos/t1');
  assert.deepEqual(todo.apns.titleArgs, ['Mathe']);
  assert.equal(todo.collapseId, 'todo-t1');
  const reminder = reminderNotice({ id: 'r1', title: 'Ausflug', body: '' });
  assert.equal(reminder.apns.url, '/reminders/r1');
  assert.equal(reminder.apns.bodyKey, 'push.tapToOpen');
});

test("a reminder's own text is sent as written", () => {
  const reminder = reminderNotice({ id: 'r1', title: 'Ausflug', body: '  Jause mitnehmen ' });
  assert.equal(reminder.apns.body, 'Jause mitnehmen');
  assert.equal(reminder.apns.bodyKey, undefined);
  assert.equal(reminder.web.body, 'Jause mitnehmen');
});

test('every notice says what kind it is, and devices choose by kind', () => {
  assert.equal(newMessagesNotice(1).kind, 'messages');
  assert.equal(todoDueNotice({ id: 't', title: 'x' }).kind, 'todos');
  assert.equal(reminderNotice({ id: 'r', title: 'x' }).kind, 'reminders');
  assert.ok(wantsKind('messages,todos,reminders', 'todos'));
  assert.equal(wantsKind('messages,reminders', 'todos'), false);
  assert.equal(wantsKind('', 'messages'), false);
});
