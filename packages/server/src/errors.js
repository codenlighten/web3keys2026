'use strict';

/**
 * Application error with an HTTP status and optional public `extra` fields merged into
 * the JSON response (e.g. { twoFactorRequired: true }). Statuses >= 500 are never
 * surfaced to clients (see the error handler in app.js).
 */
class ServiceError extends Error {
  constructor(message, status = 400, extra) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { ServiceError };
