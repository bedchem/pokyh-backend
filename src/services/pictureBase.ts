import type { Request } from 'express';
import { config } from '../config';
import { requestBase, siteHostsOf } from '../utils/publicBase';

const siteHosts = siteHostsOf(config.corsOrigin);

/** The address in front of this server's pictures in the answer to `req` (utils/publicBase.ts). */
export const pictureBase = (req: Request): string => requestBase(config.publicBaseUrl, req, siteHosts);
