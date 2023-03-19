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
  let connection: oracledb.Connection | undefined;
  let row: CisCourseCatalogRow;
  try {
    connection = await pool.getConnection();
    const result = await connection.execute<any>(
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
    // Convert null to undefined
    let row_raw = result.rows[0];
    for (const key in row_raw) {
      row_raw[key] ??= undefined;
    }
    row = row_raw as CisCourseCatalogRow;
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

  return await process_subject(row);
}

async function process_subject(row: CisCourseCatalogRow):
Promise<Subject | undefined> {
  const out: Subject = {
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

  out.level = row.HGN_CODE === "H" ? "G" : row.HGN_CODE;

  const year = parseInt(row.ACADEMIC_YEAR);
  if (year < CURRENT_YEAR) {
    out.is_historical = true;
    out.source_semester = `spring-${year}`;
  }

  if (row.JOINT_SUBJECTS) {
    out.joint_subjects =
      row.JOINT_SUBJECTS
      .split(",")
      .map(normalize_subject_id);
  }
  if (row.EQUIVALENT_SUBJECTS) {
    out.equivalent_subjects =
      row.EQUIVALENT_SUBJECTS
      .split(",")
      .map(normalize_subject_id);
  }
  if (row.MEETS_WITH_SUBJECTS) {
    out.meets_with_subjects =
      row.MEETS_WITH_SUBJECTS
      .split(",")
      .map(normalize_subject_id);
  }

  // TODO quarter_information (TERM_DURATION)

  if (row.IS_OFFERED_THIS_YEAR != "Y") {
    // Not offered this year
    out.not_offered_year = `${year-1}-${year}`;
  }

  const instructors = [];
  if ((out.offered_fall || out.offered_summer) && row.FALL_INSTRUCTORS) {
    instructors.push(`Fall: ${row.FALL_INSTRUCTORS}`);
  }
  if ((out.offered_spring || out.offered_IAP) && row.SPRING_INSTRUCTORS) {
    instructors.push(`Spring: ${row.SPRING_INSTRUCTORS}`);
  }
  if (instructors.length > 0) {
    out.instructors = instructors;
  }

  switch (row.COMM_REQ_ATTRIBUTE) {
    case "CIH":
      out.communication_requirement = "CI-H";
      break;
    case "CIHW":
      out.communication_requirement = "CI-HW";
      break;
  }
  // out.communication_requirement does not include CI-M

  out.gir_attribute = row.GIR_ATTRIBUTE;

  // TODO children, parent

  if (row.STATUS_CHANGE) {
    if (row.STATUS_CHANGE.includes("New number")) {
      // Subject has been renumbered
      return undefined;
    }
    let match = row.STATUS_CHANGE.match(/Old number:\s+(.*)/)
    if (match) {
      match = match[1].match(SUBJECT_ID_REGEX);
      if (match) {
        out.old_id = normalize_subject_id(match[0]);
      }
    }
  }

  out.description = row.SUBJECT_DESCRIPTION;

  // TODO prerequisites/corequisites

  if (row.ON_LINE_PAGE_NUMBER) {
    out.url = row.ON_LINE_PAGE_NUMBER + "#" + out.subject_id;
  }

  if (row.HASS_ATTRIBUTE) {
    out.hass_attribute = await lookup_hass_attribute(row.HASS_ATTRIBUTE);
  }

  return out;
}

function normalize_subject_id(subject_id: string): string {
  /**
   * Normalize a subject ID by removing leading/trailing whitespace, and the "J"
   * suffix for joint subjects.
   */
  return subject_id.trim().replace(/J$/, "");
}

async function lookup_hass_attribute(hass_attribute_raw: string):
Promise<string | undefined> {
  /**
   * Look up the full form of a HASS attribute string in the database
   * (e.g., "HS" -> "HASS-S").
   *
   * Returns undefined if there is no match.
   */
  let connection: oracledb.Connection | undefined;
  let rows: [string, string][];
  try {
    connection = await pool.getConnection();
    const result = await connection.execute<[string, string]>(
      "SELECT hass_attribute, description_in_bulletin FROM cis_hass_attribute"
    );
    if (result.rows === undefined) {
      return undefined;
    }
    rows = result.rows;
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
  for (const [raw, mapped] of rows) {
    if (raw === hass_attribute_raw) {
      return mapped;
    }
  }
  return undefined;
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
