# Class assignment

Every POKYH class belongs to one WebUntis class of one school. An account is
in a class only when WebUntis itself says, at a sign-in, that the signed-in
student belongs to it. Nothing else assigns a class: not a client's say, not
another record, not a guess. When WebUntis leaves it open, the account has
no class, and the account records why (`users.class_note`).

## Who gets a class

| Sign-in | Class |
| --- | --- |
| Student (`authenticate` person type 5, app-data without a guardian marker) | Their own WebUntis class |
| Guardian (person type 12, any guardian marker in the app-data such as a parents' login tagged "Elternaccount" on the child's record, or an app-data that lists children other than the person) | None |
| Teacher or any other person type | None |
| An account whose role an admin set to "parent" or "none" | None, whatever WebUntis says |
| A newer account on the same pupil's WebUntis record as an older student account of the school | None until an admin says which one is the parent (`shared_person`) |
| WebUntis did not say enough (no app-data, no answer) | The class confirmed under the current rules before; otherwise none |
| POKYH-only account | What an admin gave it |

## Roles

`decideAccountRole` (`src/utils/accountClass.ts`):

1. A role an admin chose (`users.role_locked`) stays at every sign-in. The
   admin panel's "Automatisch (WebUntis)" hands it back to WebUntis.
2. "none" stays (only an admin sets it).
3. A guardian WebUntis names is a parent.
4. A pupil WebUntis names is a student, but a parent's account stays a
   parent: a parent's login on the child's record looks exactly like the
   child (note `student_record_on_parent`, shown to admins).
5. WebUntis did not tell: the stored role stays; a new account takes the
   app's say, which can only make it a parent.

The admin's choice is copied into the school-year archive and comes back when
the account is recreated after the rollover.

## Where a student's class comes from

In this order, and only from the signed-in student's own records
(`src/webuntis/accountResolver.ts`, rules in `src/webuntis/accountClass.ts`):

1. the class `authenticate` answered for the student (or the one class of an
   app-key sign-in's `klassenIds`) — `authenticate`;
2. WebUntis' own timetable set-up for the student
   (`public/timetable/weekly/pageconfig?type=5`, their element's `klasseId`) — `pageconfig`;
3. the student's own `getStudents` record — `students`;
4. the student's own record in the app-data (`user.person`, `user.students[]`) — `app-data`;
5. the class id in a clear majority of the student's lessons in the weekly
   timetable (`public/timetable/weekly/data`, class elements by id), read
   week by week from today — `weekly-data`;
6. the class name in a clear majority of the lessons of the REST timetable,
   mapped to an id through the known classes — `timetable`;
7. the one class the school's timetable picker offers the student
   (`rest/view/v1/timetable/filter`), when it offers exactly one — `filter-single`.

A lesson shared with other classes lists those too, so the first class met
decides nothing; a timetable where two classes always come together decides
nothing either. When `getKlassen` can be read, every id must be one of its
classes (`candidate_rejected` otherwise); the timetable picker's and the
weekly timetable's classes only name a class. The source is stored in
`users.class_source`.

## Why there is no class

`users.class_note`: `role_parent`, `role_none`, `not_student`,
`appdata_unreadable`, `no_class_found`, `candidate_rejected`,
`webuntis_unavailable`, `shared_person`, `student_record_on_parent`,
`no_session`. The admin panel shows them in words and filters "Ohne
Klasse", "Wartet auf Prüfung" and "Zu prüfen"; `/auth/me` hands the website
`classNote` and `classCheckPending`.

## When it is decided

At every website sign-in and every app sign-in. A website renewal reuses what
its session worked out conclusively under the current rules; an app renewal
of an account confirmed within the last 24 hours on the same record skips
the class lookup (the session itself is checked every time).

## The apps' sign-in

`POST /auth/login` with `X-Server-Key` needs `untisSessionId`, the app's own
WebUntis session (JSESSIONID), and `school`, `schoolName` and `schoolServer`.
The key ships inside every app and proves nothing. Before anything is created
(no account, no school), the backend asks WebUntis whose the session is
(`src/webuntis/sessionIdentity.ts`):

- the bearer token WebUntis mints for it, and the app-data's login name
  (else the token's), which must be the account's;
- the session's tenant must be the school's (`schools.webuntis_tenant_id`)
  and the account's (`users.webuntis_tenant_id`). Many schools share a
  WebUntis host and the app names its school itself, so a school and every
  account keep the tenant of their first verified sign-in (`services/schoolTenant.ts`,
  `accountTenant` in `src/webuntis/identity.ts`): a same-named login of another
  school's tenant never signs in as an account, nor makes new ones whose class
  ids (numbered per tenant) would match the school's classes. A website
  sign-in POKYH makes with the password or key is the school's own word: it
  corrects a tenant an app recorded first, and the accounts of the other
  tenant lose their sessions and classes (audit `school.tenant_replaced`,
  `user.tenant_rebound`). An account's tenant survives the school-year
  rollover in the archive.

Failures: `untis_session_required`, `school_invalid`, `untis_session_invalid`,
`untis_identity_unverified`, `account_mismatch`, `tenant_mismatch`,
`webuntis_unavailable` (fail closed). The QR hand-over uses the same check.

A POKYH-only account that its holder registered themselves under that name is
taken over by the WebUntis account of its own school (its password, devices,
push, passkeys and memberships go; audit `user.local_takeover`); a sign-in of
another school is refused, as for any account. Accounts an admin made or gave a
password keep theirs. Self-registration is off unless `SELF_REGISTRATION=true`.

## Checking every assignment again

`CLASS_CHECK_VERSION` (`src/utils/accountClass.ts`) is the version of these
rules (2: admin roles stick, guardians told by their children, the sources
above); `users.class_check_version` records the version that last confirmed
an account's class (or that it has none). On the first start with a new
version (`src/services/classCheck.ts`, markers in `app_migrations`):

1. `role-lock-v1`: roles admins chose (from the audit trail) are locked; an
   admin's "parent" or "none" that a sign-in had undone comes back, without
   the class (audit `user.role.restore`).
2. `local-origin-v1`: which POKYH-only passwords an admin set.
3. `class-check-v<version>`: every WebUntis account not confirmed under the
   version leaves its class, and parent and role-less accounts lose any class
   left over. The classes and their reminders stay.

Each account's next sign-in or session renewal asks WebUntis and puts it into
the class WebUntis confirms, or leaves it without one. Active website
sessions renew at their next request; the apps at their next sign-in.

The log line `[webuntis login] resolved` shows, without personal data, what a
sign-in was (`kind`), whether a class was found (`classEvidence`), where
(`classSource`) or why not (`classNote`); `account_class_changed` records every
change of an account's class or role.
