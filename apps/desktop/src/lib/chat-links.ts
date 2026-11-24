const hasControl = (value: string): boolean =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Classify model links without letting arbitrary URI schemes reach the OS. */
export const isWebLink = (href: string): boolean => /^https?:\/\/[^/\s]/i.test(href.trim());

export const fileLinkPath = (href: string): string | null => {
  const value = href.trim();
  if (!value || hasControl(value) || value.startsWith('#')) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      const path = decodeURIComponent(url.pathname);
      return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  if (value.startsWith('//') || value.startsWith('\\\\')) return null;
  if (/^[a-z]:[\\/]/i.test(value)) return decodePath(value);
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  return decodePath(value);
};

const decodePath = (value: string): string | null => {
  try {
    // Editor line/column fragments are not part of the file's name.
    const path = decodeURIComponent(value.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, ''));
    return path && !hasControl(path) ? path : null;
  } catch {
    return null;
  }
};
