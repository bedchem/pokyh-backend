# Class assignment

Every POKYH class belongs to one WebUntis class of one school. An account is
in a class only when WebUntis itself says, at a sign-in, that the signed-in
student belongs to it. Nothing else assigns a class: not a client's say, not
another record, not a guess. When WebUntis leaves it open, the account has
no class.

## Who gets a class

| Sign-in | Class |
| --- | --- |
| Student (`authenticate` person type 5, app-data without a guardian marker) | Their own WebUntis class |
| Guardian (person type 12, or any guardian marker in the app-data, such as a parents' login tagged "Elternaccount" on the child's record) | None |
| Teacher or any other person type | None |
| WebUntis did not say enough (no app-data, no answer) | The class confirmed under the current rules before; otherwise none |
| Account with the role "none" (set by an admin) | None |
| POKYH-only account | What an admin gave it |

## Where a student's class comes from

In this order, and only from the signed-in student's own records
(`src/webuntis/accountResolver.ts`, rules in `src/webuntis/accountClass.ts`):

1. the class `authenticate` answered for the student;
2. the student's own `getStudents` record;
3. the student's own record in the app-data (`user.person`, `user.students[]`);
4. the student's timetable: the class in more than half of their lessons and
   ahead of every other, read week by week from today. A lesson shared with
   other classes lists those too, so the first class met decides nothing; a
   timetable where two classes always come together decides nothing either.

Every id must be one of the school's classes (`getKlassen`); the name comes
from there. An id that is none of them is no class.

## When it is decided

At every website sign-in and every app sign-in that hands over its WebUntis
session. A website renewal reuses what its session worked out conclusively
under the current rules; anything else is looked up again.

The app sign-in (`POST /auth/login`, server key) sends `untisSessionId`, the
app's own WebUntis session (JSESSIONID), together with `school`, `schoolName`
and `schoolServer`. The backend asks WebUntis with it; the class counts only
when the app-data shows the same login name. Without `untisSessionId` the
account gets no class: `klasseId` and `klasseName` from the app are ignored,
and `role: "parent"` is taken, while `"student"` never turns a parent back into
a student.

Joining a class by its code works only for the account's own confirmed class.

## Checking every assignment again

`CLASS_CHECK_VERSION` (`src/utils/accountClass.ts`) is the version of these
rules; `users.class_check_version` records the version that last confirmed
an account's class (or that it has none). Raising the version checks every
assignment once more: on the first start with the new version
(`src/services/classCheck.ts`, marker `class-check-v<version>` in
`app_migrations`) every WebUntis account not confirmed under it leaves its
class, and parent and role-less accounts lose any class left over. The classes
and their reminders stay. Each account's next sign-in or session renewal
asks WebUntis and puts it into the class WebUntis confirms, or leaves it
without one. Active website sessions renew within four hours at the latest.

The log line `[webuntis login] resolved` shows, without personal data, what a
sign-in was (`kind`), whether a class was found (`classEvidence`) and where
(`classSource`); `account_class_changed` records every change of an account's
class or role.
