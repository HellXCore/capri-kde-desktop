'use strict';

// The schema kit every trust boundary speaks: IPC payloads, the agent protocol, the KWin script's
// JSON, the hooks bridge. A validator is a plain function — it returns the value normalised, or
// throws a ValidationError whose `path` names the exact field (`rects[2].w`). Normalisation is
// small and deliberate: strings are trimmed and cut to their declared length; numbers are never
// clamped (out of range is an error); objects carry only their declared keys, so nothing
// unvalidated rides along. No dependencies, no state: a check is built once and reused.

/**
 * A check for one value. Combinators (obj, arr, opt) thread `path` down so an error names where
 * it happened; a caller passes only the value.
 * @template T
 * @typedef {(value: unknown, path?: string) => T} Validator
 */

class ValidationError extends Error {
  /** @param {string} path @param {string} msg */
  constructor(path, msg) {
    super(path ? `${path}: ${msg}` : msg);
    this.name = 'ValidationError';
    this.path = path;
  }
}

/** A field's path under its parent: '' + 'w' -> 'w', 'rects[2]' + 'w' -> 'rects[2].w'. */
/** @param {string} path @param {string} key */
const at = (path, key) => (path ? `${path}.${key}` : key);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * An object of exactly the declared keys. An undeclared key is an error (the default); with
 * { strict: false } it is dropped, never passed through unvalidated. An absent optional key
 * stays absent; an absent required key fails its own check, at its own path.
 * @param {Record<string, Validator<unknown>>} shape
 * @param {{ strict?: boolean }} [opts]
 * @returns {Validator<Record<string, unknown>>}
 */
function obj(shape, { strict = true } = {}) {
  const keys = Object.keys(shape);
  return (value, path = '') => {
    if (!isRecord(value)) throw new ValidationError(path, 'expected an object');
    if (strict) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) throw new ValidationError(at(path, key), 'unknown key');
      }
    }
    /** @type {Array<[string, unknown]>} */
    const out = [];
    for (const key of keys) {
      // own properties only: a value inherited from Object.prototype was not sent by anyone
      const raw = Object.hasOwn(value, key) ? value[key] : undefined;
      const norm = shape[key](raw, at(path, key));
      if (norm !== undefined) out.push([key, norm]);
    }
    return Object.fromEntries(out);
  };
}

/**
 * A string, trimmed; anything past `max` is cut rather than refused.
 * @param {{ max?: number }} [opts]
 * @returns {Validator<string>}
 */
function str({ max = Infinity } = {}) {
  return (value, path = '') => {
    if (typeof value !== 'string') throw new ValidationError(path, 'expected a string');
    const s = value.trim();
    return s.length > max ? s.slice(0, max) : s;
  };
}

/**
 * A finite number in [min, max]. Never clamped: out of range is an error, not a silent repair.
 * @param {number} [min] @param {number} [max]
 * @returns {Validator<number>}
 */
function num(min = -Infinity, max = Infinity) {
  return (value, path = '') => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(path, 'expected a finite number');
    if (value < min || value > max) throw new ValidationError(path, `out of range [${min}, ${max}]`);
    return value;
  };
}

/**
 * An integer in [min, max].
 * @param {number} [min] @param {number} [max]
 * @returns {Validator<number>}
 */
function int(min = -Infinity, max = Infinity) {
  return (value, path = '') => {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new ValidationError(path, 'expected an integer');
    if (value < min || value > max) throw new ValidationError(path, `out of range [${min}, ${max}]`);
    return value;
  };
}

/** @returns {Validator<boolean>} */
function bool() {
  return (value, path = '') => {
    if (typeof value !== 'boolean') throw new ValidationError(path, 'expected a boolean');
    return value;
  };
}

/**
 * One of a fixed set, compared with === (no coercion). The matched member is returned, so the
 * value that comes out is one the schema itself owns.
 * @template {string | number | boolean} T
 * @param {readonly T[]} allowed
 * @returns {Validator<T>}
 */
function oneOf(allowed) {
  return (value, path = '') => {
    for (const a of allowed) if (a === value) return a;
    throw new ValidationError(path, `expected one of: ${allowed.join(', ')}`);
  };
}

/**
 * May be absent (undefined): then it stays absent. Anything present goes through the inner check.
 * @template T
 * @param {Validator<T>} inner
 * @returns {Validator<T | undefined>}
 */
function opt(inner) {
  return (value, path = '') => (value === undefined ? undefined : inner(value, path));
}

/**
 * An array; every item goes through the inner check, its errors named `list[i]`. `max` bounds
 * the length, so a hostile sender cannot make a decoder walk without end.
 * @template T
 * @param {Validator<T>} inner
 * @param {{ max?: number }} [opts]
 * @returns {Validator<T[]>}
 */
function arr(inner, { max = Infinity } = {}) {
  return (value, path = '') => {
    if (!Array.isArray(value)) throw new ValidationError(path, 'expected an array');
    if (value.length > max) throw new ValidationError(path, `at most ${max} items`);
    return value.map((item, i) => inner(item, `${path}[${i}]`));
  };
}

const v = { obj, arr, str, num, int, bool, oneOf, opt };

module.exports = { v, ValidationError };