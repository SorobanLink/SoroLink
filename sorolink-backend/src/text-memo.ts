export const TEXT_MEMO_MAX_BYTES = 28;

/** Reject malformed Unicode and unsafe control characters rather than silently replacing or echoing them. */
export function isTextMemo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (Buffer.byteLength(value, "utf8") > TEXT_MEMO_MAX_BYTES) return false;
  if (Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)) return false;
  return true;
}
