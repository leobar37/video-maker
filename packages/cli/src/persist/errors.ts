/**
 * Persistence error type (FR-012): every refusal carries an actionable,
 * operator-facing message. Handlers map it to `ctx.fail(message)`.
 */
export class PersistError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistError';
  }
}
