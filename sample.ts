// Top-level declarations should be yellow; everything local stays near-black
import { readFile } from "node:fs/promises";

/** A user record loaded from disk. */
export interface User {
  id: string;
  name: string;
  tags: readonly string[];
}

export type UserMap = Map<string, User>;

const DEFAULT_NAME = "anonymous";
let loadCount = 0;

export default class UserStore<T extends User = User> {
  private users: UserMap = new Map();

  async load(path: string): Promise<number> {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as User[];
    for (const user of parsed) {
      if (!user.name) {
        continue;
      }
      this.users.set(user.id, user);
    }
    loadCount++;
    return parsed.length;
  }
}

export function describe(user: User | undefined): string {
  const label = user ? `${user.name} (${user.id})` : DEFAULT_NAME;
  try {
    return label.length > 20 ? label.slice(0, 20) : label;
  } catch (err) {
    throw new Error(`Failed: ${String(err)}`);
  }
}

export const shout = (text: string) => text.toUpperCase();
