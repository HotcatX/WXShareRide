export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireThat(condition, status, code) {
  if (!condition) throw new ApiError(status, code);
}
