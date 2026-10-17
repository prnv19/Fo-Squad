// Every edge case, by file. Add a new file's `cases` here.

import type { EdgeCase } from "../types.js";
import { cases as booking } from "./booking.js";
import { cases as claims } from "./claims.js";
import { cases as planning } from "./planning.js";
import { cases as security } from "./security.js";

export const allCases: EdgeCase[] = [...planning, ...booking, ...claims, ...security];
