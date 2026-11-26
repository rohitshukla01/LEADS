// Loads .env.local before any module that reads settings when it is imported.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
