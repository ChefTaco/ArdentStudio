import type { Principal } from '../auth/oathweave.js';

export interface AppEnv {
  Variables: {
    principal: Principal | undefined;
  };
}
