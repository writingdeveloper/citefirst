import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * .env 를 읽는다. Node 20.12+ 내장 기능이라 dotenv 의존성이 필요 없다.
 * 이미 설정된 환경변수를 덮어쓰지 않는다.
 */
export function loadEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}
