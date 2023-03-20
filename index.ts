/**
 * Wrapper script around fetch.ts
 *
 * This is necessary because LD_LIBRARY_PATH needs to be set appropriately
 * before the node process starts, so a wrapper script to set environment
 * variables is necessary.
 */

import child_process from "child_process";
import path from "path";

import * as dotenv from "dotenv";
dotenv.config();

if (process.env.ORACLE_HOME !== undefined) {
  // Add $ORACLE_HOME to $LD_LIBRARY_PATH
  if (process.env.LD_LIBRARY_PATH !== undefined) {
    process.env.LD_LIBRARY_PATH =
      `${process.env.ORACLE_HOME}:${process.env.LD_LIBRARY_PATH}`;
  } else {
    process.env.LD_LIBRARY_PATH = process.env.ORACLE_HOME;
  }
}

const script_path = path.join(__dirname, "fetch.js");

// Run script with the arguments we were given
child_process.fork(script_path, process.argv.slice(2));
