/**
 * Where the small JSON data files live (blacklists, strategy library, signal weights).
 *
 * They belong next to the code, so the agent finds them whatever directory it is started from. Older versions
 * wrote them into the working directory instead: if a file is not next to the code but one with the same name
 * sits in the working directory, that one is used (and stays where it is), so an existing blacklist is not
 * silently replaced by an empty one after an update.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function dataFile(name) {
  const here = path.join(HERE, name);
  if (fs.existsSync(here)) return here;
  const inCwd = path.resolve(process.cwd(), name);
  if (inCwd !== here && fs.existsSync(inCwd)) {
    log("paths", `${name}: using the copy in the working directory (${inCwd}) — move it next to the code to make this permanent`);
    return inCwd;
  }
  return here;
}
