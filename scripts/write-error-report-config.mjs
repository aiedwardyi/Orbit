import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? fileURLToPath(new URL("../electron/error-report-config.json", import.meta.url));
writeFileSync(target, JSON.stringify({ dsn: process.env.ERROR_REPORT_DSN?.trim() ?? "" }));
