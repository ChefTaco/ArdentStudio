import type { z } from 'zod';
import type { projectEventTypeSchema } from '../shared/browser.js';

export type ProjectEventType = z.infer<typeof projectEventTypeSchema>;
