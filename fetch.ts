import oracledb from "oracledb";

import { CisCourseCatalogRow, Subject } from "./types";

const CURRENT_YEAR = 2023;
const MIN_YEAR = 2016;

const SUBJECT_ID_REGEX = /([A-Z0-9.-]+)(\[J\])?(,?)/;
const SCHEDULE_NON_EVENING_REGEX = /([MTWRFS]+)(\d(\.\d+)?(-\d(\.\d+)?)?)/;
const SCHEDULE_EVENING_REGEX = /([MTWRFS]+)\s+EVE\s*\((.+)\)/;

let pool: oracledb.Pool;

async function init() {
  if (!process.env.WAREHOUSE_USERNAME || !process.env.WAREHOUSE_PASSWORD) {
    throw "WAREHOUSE_USERNAME and/or WAREHOUSE_PASSWORD not provided";
  }

  try {
    pool = await oracledb.createPool({
      user: process.env.WAREHOUSE_USERNAME,
      password: process.env.WAREHOUSE_PASSWORD,
      connectString: "warehouse",
    });
  } catch (err) {
    throw err;
  }
}

async function fetch_subject(subject_id: string): Promise<Subject | undefined> {
  /**
   * Query the database and fetch the subject with the provided subject ID
   *
   * Returns undefined if the subject was not found.
   */
  let connection;
  let row;
  try {
    connection = await pool.getConnection();
    const result = await connection.execute<CisCourseCatalogRow>(
      `SELECT * FROM cis_course_catalog
      WHERE subject_id = :subject_id
      AND academic_year >= :min_year
      ORDER BY academic_year DESC`,
      { subject_id: subject_id, min_year: MIN_YEAR },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (result.rows === undefined) {
      return undefined;
    }
    row = result.rows[0];
  } catch (err) {
    throw err;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        throw err;
      }
    }
  }

  return {
    subject_id: row.SUBJECT_ID,
    title: row.SUBJECT_TITLE ?? "",
    total_units: row.TOTAL_UNITS ?? 0,
    offered_fall: row.IS_OFFERED_FALL_TERM === "Y",
    offered_IAP: row.IS_OFFERED_IAP === "Y",
    offered_spring: row.IS_OFFERED_SPRING_TERM === "Y",
    offered_summer: row.IS_OFFERED_SUMMER_TERM === "Y",
    public: true,

    lecture_units: row.LECTURE_UNITS ?? 0,
    lab_units: row.LAB_UNITS ?? 0,
    design_units: row.DESIGN_UNITS ?? 0,
    preparation_units: row.PREPARATION_UNITS ?? 0,
    is_variable_units: row.IS_VARIABLE_UNITS === "Y",
    is_half_class: false,
    has_final: false, // FIXME
  };
}

async function run() {
  if (process.argv[2] === undefined) {
    console.error("Usage: npm start <subject_id>");
    process.exit(1);
  }
  const subject_id = process.argv[2];

  try {
    await init();
    console.log(await fetch_subject(subject_id));
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await pool.close();
  }
}

run();
