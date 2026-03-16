import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const FILE_PATH = join(DATA_DIR, "records.json");
const UPDATED_AT_PATH = join(DATA_DIR, "updated_at.txt");

export interface ElectricityRecord {
  date: string;
  fetchedAt: string;
  balance: string;
  usage: string;
  peakUsage: string;
  valleyUsage: string;
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readRecords(): ElectricityRecord[] {
  ensureDir();
  if (!existsSync(FILE_PATH)) return [];
  try {
    const text = readFileSync(FILE_PATH, "utf-8");
    return JSON.parse(text) as ElectricityRecord[];
  } catch {
    return [];
  }
}

export function readUpdatedAt(): string {
  ensureDir();
  if (!existsSync(UPDATED_AT_PATH)) return "";
  try {
    return readFileSync(UPDATED_AT_PATH, "utf-8").trim();
  } catch {
    return "";
  }
}

/** 批量保存，按日期合并（新数据覆盖旧数据），按日期降序排列 */
export async function saveRecords(
  newRecords: ElectricityRecord[],
): Promise<void> {
  ensureDir();
  const existing = readRecords();

  const map = new Map<string, ElectricityRecord>();
  for (const r of existing) map.set(r.date, r);
  for (const r of newRecords) map.set(r.date, r);

  const merged = Array.from(map.values()).sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  await Bun.write(FILE_PATH, JSON.stringify(merged, null, 2));
  await Bun.write(UPDATED_AT_PATH, new Date().toISOString());
}
