import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDoctorFailures, renderDoctorReport, runDoctor } from "./app/doctor.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..");

const report = await runDoctor({ projectRoot });
console.log(renderDoctorReport(report));

if (hasDoctorFailures(report)) {
  process.exitCode = 1;
}
