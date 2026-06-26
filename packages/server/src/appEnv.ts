import type {Principal} from '@book.dev/sdk';

/** Per-request state the principal middleware attaches to the Hono context. */
export type AppVariables = {principal: Principal};

/** The Hono environment shared by the app and its mounted route groups. */
export type AppEnv = {Variables: AppVariables};
