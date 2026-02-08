import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devWarn } from "../../shared/index.js";
import {
  emptyUserProfileContext,
  isUserProfileContext,
  type UserProfileContext,
} from "../types.js";
import { readJsonFile } from "./io.js";

const USER_PROFILE_FILE = "user_profile.json";

export async function loadUserProfileContext(): Promise<UserProfileContext> {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const contextDir = resolve(thisDir, "..", "..", "..", "context");
  const filePath = resolve(contextDir, USER_PROFILE_FILE);

  const raw = await readJsonFile(filePath, USER_PROFILE_FILE);
  if (isUserProfileContext(raw)) {
    return raw;
  }

  devWarn("User profile context missing or invalid. Using empty user profile context.");
  return emptyUserProfileContext();
}
