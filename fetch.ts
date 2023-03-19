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
    let match = row.STATUS_CHANGE.match(/Old number:\s+(.*)/);
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

  [out.schedule_fall, out.schedule_iap, out.schedule_spring] =
    await fetch_schedules(out.subject_id, year);
  out.schedule = out.schedule_spring ?? out.schedule_iap ?? out.schedule_fall;

  // TODO related subjects

  // TODO course evals

  // TODO support corrections

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

async function fetch_schedules(subject_id: string, year: number):
Promise<[string | undefined, string | undefined, string | undefined]> {
  /**
   * Query the database and fetch the schedule(s) for a subject in a specified
   * academic year (given as an int) and form a schedule string in a
   * standardized format.
   *
   * The format for a schedule is a semicolon-separated list of sections, where
   * each section is a comma-separated list in which:
   * - the first entry of a section is "Lecture", "Recitation", "Lab", or
   *   "Design";
   * - each subsequent entry of a section is a meeting, where
   *   + each meeting is either "TBA" or a slash-separated list;
   *   + the first entry is the room number; e.g.,
   *      "54-1423", "VIRTUAL", "NORTH SHORE";
   *   + the second entry is one or more characters from "M", "T", "W", "R",
   *      "F", "S";
   *   + the third entry is either "0" or "1";
   *   + if the third entry is "0", the fourth entry is a non-evening hour;
   *       e.g., "9" or "1-2.30";
   *   + if the third entry is "1", the fourth entry is an evening hour;
   *       e.g., "4-7 PM" or "5.30 PM".
   *
   * For example, the following schedule would lead to the following output:
   *
   * Schedule:
   *     Lecture: MWF 10am (10-250)
   *     Recitation: M 11am (34-101), M 1pm (34-303), M 7pm (34-302), T 10am (34-301)
   *
   * Output:
   *     Lecture,10-250/MWF/0/10;Recitation,34-301/M/0/11,34-302/M/1/7 PM,34-301/T/0/10
   *
   * Returns an array [fall, iap, spring], where each may be undefined.
   */
  const fetch_term = async (term_code: string): Promise<string | undefined> => {
    const lectures: string[] = [];
    const recitations: string[] = [];
    const labs: string[] = [];
    const designs: string[] = [];

    let connection: oracledb.Connection | undefined;
    let rows: (string | undefined)[][];
    try {
      connection = await pool.getConnection();
      const result = await connection.execute<(string | undefined)[]>(
        `SELECT meet_place, meet_time, is_lecture_section,
          is_recitation_section, is_lab_section, is_design_section
        FROM subject_offered
        WHERE subject_id = :subject_id
        AND term_code = :term_code
        AND is_master_section = 'N'
        ORDER BY is_lecture_section DESC, is_recitation_section DESC,
          is_lab_section DESC, section_id`,
        { subject_id, term_code }
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

    for (const [meet_place, meet_time, lec, rec, lab, des] of rows) {
      let dest;
      if (lec === "Y") {
        dest = lectures;
      } else if (rec === "Y") {
        dest = recitations;
      } else if (lab === "Y") {
        dest = labs;
      } else if (des === "Y") {
        dest = designs;
      } else {
        throw `Encountered unknown section type for subject ${subject_id}`;
      }

      if (!meet_place || !meet_time) {
        dest.push("TBA");
        continue;
      }

      for (let time of meet_time.split(",")) {
        time = time.trim();

        let match = time.match(SCHEDULE_NON_EVENING_REGEX);
        if (match) {
          const days = match[1];
          const hours = match[2];
          dest.push(`${meet_place}/${days}/0/${hours}`);
          continue;
        }

        match = time.match(SCHEDULE_EVENING_REGEX);
        if (match) {
          const days = match[1];
          const hours = match[2];
          dest.push(`${meet_place}/${days}/1/${hours}`);
          continue;
        }

        dest.push("TBA");
        console.log(`Could not parse schedule ${meet_time} for subject ${
          subject_id
        }`);
      }
    }

    let out = "";
    if (lectures.length > 0) {
      out += ";Lecture," + lectures.join(",")
    }
    if (recitations.length > 0) {
      out += ";Recitation," + recitations.join(",")
    }
    if (labs.length > 0) {
      out += ";Lab," + labs.join(",")
    }
    if (designs.length > 0) {
      out += ";Design," + designs.join(",")
    }
    return out.slice(1) || undefined;
  };

  const [fall, iap, spring] = await Promise.all(
    [`${year}FA`, `${year}JA`, `${year}SP`].map(fetch_term)
  );
  return [fall, iap, spring];
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
