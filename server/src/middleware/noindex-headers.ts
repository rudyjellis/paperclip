import type { RequestHandler } from "express";

export const NOINDEX_ROBOTS_TAG = "noindex, nofollow";

/** Tell crawlers this private host must not be indexed. */
export function noindexHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Robots-Tag", NOINDEX_ROBOTS_TAG);
    next();
  };
}
