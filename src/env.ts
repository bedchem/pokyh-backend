// Loads `.env` before anything reads the environment (the first import of
// index.ts and config.ts). Quiet: dotenv would otherwise log a line at start.
import { config } from 'dotenv';

config({ quiet: true });
