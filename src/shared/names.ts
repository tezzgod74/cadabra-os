// What Cadabra calls you. Account names are often handles ("jdoe42",
// "dev_2024"); greeting someone with one is worse than not using a name.
// REVIEW-2 N7: this is only a *soft* warning ("Use it anyway"), and real
// names in any script (Lloyd, Dmitri, Kwame, Gwen, Nnamdi, 王芳, Ng) pass.

/** True when a name looks like a username/handle rather than a first name. */
export function looksLikeHandle(name: string, username?: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/[\p{N}_@.\\/#$%&*+=<>|~^]/u.test(n)) return true;
  if (n.length > 24) return true;
  if (!/^[\p{L}\p{M}' -]+$/u.test(n)) return true;
  // Exactly the Windows account name, all lower-case ("jdoe"): probably a login.
  if (username && n.toLowerCase() === username.toLowerCase() && n === n.toLowerCase() && n.length > 3) return true;
  return false;
}

/** Tidy a typed name: trim, collapse spaces, capitalise the first letter. */
export function tidyName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
}
