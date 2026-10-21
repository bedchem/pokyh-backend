// The stars a comment's author gave the dish, shown beside the name in the
// thread. Matched by account first. A stableUid is not forever, though: when
// the user row is recreated (school-year rollover, database rebuild) the
// votes move to the new one (services/dishRatings.ts reclaimDishRatings)
// while earlier comments keep the old one — so a comment without a vote under
// its stableUid falls back to the account name, within the author's school.

export type CommentStarsVote = { stableUid: string; username: string | null; schoolId: string | null; stars: number };
type CommentAuthor = { stableUid: string; username: string; schoolId: string | null };

// Usernames are compared case-insensitively, as in services/dishRatings.ts.
const nameKey = (schoolId: string | null, username: string) => `${schoolId ?? ''}|${username.trim().toLowerCase()}`;

export function withStars<C extends CommentAuthor>(comments: C[], votes: CommentStarsVote[]): (C & { stars: number | null })[] {
  const byUid = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const v of votes) {
    byUid.set(v.stableUid, v.stars);
    if (v.username) byName.set(nameKey(v.schoolId, v.username), v.stars);
  }
  return comments.map((c) => ({
    ...c,
    stars: byUid.get(c.stableUid) ?? byName.get(nameKey(c.schoolId, c.username)) ?? null,
  }));
}
