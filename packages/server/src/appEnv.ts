import type {Principal} from '@book.dev/sdk';

/** Per-request state the principal middleware attaches to the Hono context. */
export type AppVariables = {
  principal: Principal;
  /**
   * True when the request presented the host's per-run local-owner secret over a
   * non-forwarded transport (the loopback-owner hatch). Routes that gate on the
   * instance owner also accept this: the machine owner keeps authority over their
   * own instance even when their account identity is absent, stale, or drifted.
   */
  localOwner?: boolean;
};

/** The Hono environment shared by the app and its mounted route groups. */
export type AppEnv = {Variables: AppVariables};
