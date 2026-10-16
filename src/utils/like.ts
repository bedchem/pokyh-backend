// Text for a Prisma `contains` / `startsWith` filter, matched literally.
//
// Prisma passes the value into MySQL's LIKE without escaping its wildcards:
// a search for "%" or "_" would otherwise match every row (and "a_b" any
// "a?b"). Backslash is MySQL's default LIKE escape character.
export function likeText(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
