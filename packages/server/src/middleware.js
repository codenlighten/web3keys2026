'use strict';

/**
 * Request-body validation middleware backed by the shared zod schemas. On success the
 * parsed (coerced, stripped) value replaces req.body; on failure → 400 with field detail.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      return res.status(400).json({
        error: 'invalid request',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
