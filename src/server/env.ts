import type { Principal } from '../auth/authenticator.js';

export interface AppEnv {
  Variables: {
    principal: Principal | undefined;
  };
}
