import oracledb from "oracledb";

import {
  CisCourseCatalogRow,
  Schedule,
  Schedules,
  Subject,
  SubjectOfferedRow,
} from "./types";

const CURRENT_YEAR = 2023;
const MIN_YEAR = 2016;

const SUBJECT_ID_REGEX = /([A-Z0-9.-]+)(\[J\])?(,?)/;
const SCHEDULE_NON_EVENING_REGEX = /([MTWRFS]+)\s*(\d(\.\d+)?(-\d(\.\d+)?)?)/;
const SCHEDULE_EVENING_REGEX = /([MTWRFS]+)\s+EVE\s*\((.+)\)/;

let pool: oracledb.Pool;

async function init(): Promise<void> {
  if (!process.env.WAREHOUSE_USERNAME || !process.env.WAREHOUSE_PASSWORD) {
    throw "WAREHOUSE_USERNAME and/or WAREHOUSE_PASSWORD not provided";
  }

  pool = await oracledb.createPool({
    user: process.env.WAREHOUSE_USERNAME,
    password: process.env.WAREHOUSE_PASSWORD,
    connectString: "warehouse",
    queueMax: -1,
    queueTimeout: 0,
  });
}

/**
 * Query the database and fetch the subject with the provided subject ID.
 *
 * Returns undefined if the subject was not found or has been renumbered.
 */
async function fetch_subject(subject_id: string): Promise<Subject | undefined> {
  let connection: oracledb.Connection | undefined;
  let row: CisCourseCatalogRow;
  try {
    connection = await pool.getConnection();
    const result = await connection.execute<any>(
      `select * from CIS_COURSE_CATALOG
      where SUBJECT_ID = :subject_id
      and ACADEMIC_YEAR >= :MIN_YEAR
      order by ACADEMIC_YEAR desc`,
      { subject_id, MIN_YEAR },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (result.rows === undefined) {
      return undefined;
    }
    // Convert null to undefined
    const row_raw = result.rows[0];
    for (const key in row_raw) {
      row_raw[key] ??= undefined;
    }
    row = row_raw as CisCourseCatalogRow;
  } finally {
    if (connection) {
      await connection.close();
    }
  }

  return await process_subject(row);
}

async function fetch_all_subjects(): Promise<Map<string, Subject> | undefined> {
  console.log("Fetching index of subjects...");

  let connection: oracledb.Connection | undefined;
  let subjects: Map<string, number>;
  try {
    connection = await pool.getConnection();
    const result = await connection.execute<[string, string]>(
      `select SUBJECT_ID, ACADEMIC_YEAR from CIS_COURSE_CATALOG
      where ACADEMIC_YEAR >= :MIN_YEAR
      order by ACADEMIC_YEAR`,
      { MIN_YEAR },
    );
    if (result.rows === undefined) {
      return undefined;
    }
    const rows: [string, number][] = result.rows.map(([subj, year]) =>
      [subj, parseInt(year)]
    );
    subjects = new Map(rows);
  } finally {
    if (connection) {
      await connection.close();
    }
  }

  console.log(`${subjects.size} subjects received.`);

  const out = new Map<string, Subject>();
  for (let year = MIN_YEAR; year <= CURRENT_YEAR; year++) {
    console.log(`Processing year ${year}`);
    let rows: CisCourseCatalogRow[];
    try {
      connection = await pool.getConnection();
      const result = await connection.execute<any>(
        `select * from CIS_COURSE_CATALOG
        where ACADEMIC_YEAR = :year`,
        { year },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      if (result.rows === undefined) {
        return undefined;
      }
      // Convert null to undefined
      for (const row of result.rows) {
        for (const key in row) {
          row[key] ??= undefined;
        }
      }
      rows = result.rows as CisCourseCatalogRow[];
    } finally {
      if (connection) {
        await connection.close();
      }
    }

    await Promise.all(rows.map(async row => {
      const subject_id = row.SUBJECT_ID;
      if (subjects.get(subject_id) === year) {
        const processed = await process_subject(row);
        if (processed) {
          out.set(subject_id, processed);
        }
      }
    }));
  }

  return out;
}

/**
 * Given a row from the CIS_COURSE_CATALOG table of the database, process it
 * into a FireRoad-compatible format.
 *
 * Returns undefined if the subject has been renumbered.
 */
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

  // Instructors data from subject_offered is more accurate than from
  // cis_course_catalog
  let {
    fall: {
      schedule: schedule_fall,
      instructor: instructors_fall,
    },
    iap: {
      schedule: schedule_iap,
      instructor: instructors_iap,
    },
    spring: {
      schedule: schedule_spring,
      instructor: instructors_spring,
    },
  } = await fetch_schedules(out.subject_id, year);

  // Fall back to instructors data from cis_course_catalog
  if (out.offered_fall) {
    instructors_fall ??= row.FALL_INSTRUCTORS;
  }
  if (out.offered_spring) {
    instructors_spring ??= row.SPRING_INSTRUCTORS;
  }

  out.schedule = schedule_spring ?? schedule_iap ?? schedule_fall;
  out.schedule_fall = schedule_fall;
  out.schedule_iap = schedule_iap;
  out.schedule_spring = schedule_spring;

  const instructors = [];
  if (instructors_fall) {
    instructors.push(`Fall: ${instructors_fall}`);
  }
  if (instructors_iap) {
    instructors.push(`IAP: ${instructors_iap}`);
  }
  if (instructors_spring) {
    instructors.push(`Spring: ${instructors_spring}`);
  }
  if (instructors.length > 0) {
    out.instructors = instructors;
  }

  // TODO related subjects

  // TODO course evals

  // TODO support corrections

  return out;
}

/**
 * Normalize a subject ID by removing leading/trailing whitespace, and the "J"
 * suffix for joint subjects.
 */
function normalize_subject_id(subject_id: string): string {
  return subject_id.trim().replace(/J$/, "");
}

/**
 * Look up the full form of a HASS attribute string in the database
 * (e.g., "HS" -> "HASS-S").
 *
 * Returns undefined if there is no match.
 */
async function lookup_hass_attribute(hass_attribute_raw: string):
Promise<string | undefined> {
  let connection: oracledb.Connection | undefined;
  let rows: [string, string][];
  try {
    connection = await pool.getConnection();
    const result = await connection.execute<[string, string]>(
      "select HASS_ATTRIBUTE, DESCRIPTION_IN_BULLETIN from CIS_HASS_ATTRIBUTE"
    );
    if (result.rows === undefined) {
      return undefined;
    }
    rows = result.rows;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
  for (const [raw, mapped] of rows) {
    if (raw === hass_attribute_raw) {
      return mapped;
    }
  }
  return undefined;
}

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
 *   + the first entry is the room number;
 *      e.g., "54-1423", "VIRTUAL", "NORTH SHORE";
 *   + the second entry is one or more characters from
 *      "M", "T", "W", "R", "F", "S";
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
async function fetch_schedules(subject_id: string, year: number):
Promise<Schedules> {
  const fetch_term = async (term_code: string): Promise<Schedule> => {
    let connection: oracledb.Connection | undefined;
    let instructor: string | undefined = undefined;
    let rows: SubjectOfferedRow[];
    try {
      connection = await pool.getConnection();
      const result = await connection.execute<[string | null]>(
        `select RESPONSIBLE_FACULTY_NAME
        from SUBJECT_OFFERED
        where SUBJECT_ID = :subject_id
        and TERM_CODE = :term_code
        and IS_MASTER_SECTION = 'Y'`,
        { subject_id, term_code }
      );
      instructor = result.rows?.[0]?.[0] ?? undefined;

      const result2 = await connection.execute<any>(
        `select MEET_PLACE, MEET_TIME, IS_LECTURE_SECTION,
          IS_RECITATION_SECTION, IS_LAB_SECTION, IS_DESIGN_SECTION
        from SUBJECT_OFFERED
        where SUBJECT_ID = :subject_id
        and TERM_CODE = :term_code
        and IS_MASTER_SECTION = 'N'
        order by IS_LECTURE_SECTION desc, IS_RECITATION_SECTION desc,
          IS_LAB_SECTION desc, SECTION_ID`,
        { subject_id, term_code },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      if (result2.rows === undefined) {
        return { schedule: undefined, instructor: instructor };
      }
      // Convert null to undefined
      for (const row of result2.rows) {
        for (const key in row) {
          row[key] ??= undefined;
        }
      }
      rows = result2.rows as SubjectOfferedRow[];
    } finally {
      if (connection) {
        await connection.close();
      }
    }

    return {
      schedule: parse_schedule(subject_id, rows),
      instructor: instructor,
    };
  };

  const [fall, iap, spring] = await Promise.all(
    [`${year}FA`, `${year}JA`, `${year}SP`].map(fetch_term)
  );
  return { fall, iap, spring };
}

function parse_schedule(subject_id: string, rows: SubjectOfferedRow[]):
string | undefined {
  const lectures: string[] = [];
  const recitations: string[] = [];
  const labs: string[] = [];
  const designs: string[] = [];

  for (const row of rows) {
    let dest;
    if (row.IS_LECTURE_SECTION === "Y") {
      dest = lectures;
    } else if (row.IS_RECITATION_SECTION === "Y") {
      dest = recitations;
    } else if (row.IS_LAB_SECTION === "Y") {
      dest = labs;
    } else if (row.IS_DESIGN_SECTION === "Y") {
      dest = designs;
    } else {
      throw `Encountered unknown section type for subject ${subject_id}`;
    }

    if (!row.MEET_PLACE || !row.MEET_TIME) {
      dest.push("TBA");
      continue;
    }

    const meet_time = row.MEET_TIME.replace(":", ".");

    if ([/tba/i, /tbd/i, /^\*/, /arranged/i].some(x => meet_time.match(x))) {
      dest.push("TBA");
      continue;
    }

    for (let time of meet_time.split(",")) {
      time = time.trim();

      let match = time.match(SCHEDULE_NON_EVENING_REGEX);
      if (match) {
        const days = match[1];
        const hours = match[2];
        dest.push(`${row.MEET_PLACE}/${days}/0/${hours}`);
        continue;
      }

      match = time.match(SCHEDULE_EVENING_REGEX);
      if (match) {
        const days = match[1];
        const hours = match[2];
        dest.push(`${row.MEET_PLACE}/${days}/1/${hours}`);
        continue;
      }

      dest.push("TBA");
      console.log(`Could not parse schedule ${row.MEET_TIME} for subject ${
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
}

async function run(): Promise<void> {
  if (process.argv[2] === undefined) {
    console.error("Usage: npm start <subject_id>");
    process.exit(1);
  }
  const subject_id = process.argv[2];

  try {
    await init();

    console.log(await fetch_subject(subject_id));

    // const subjects = await fetch_all_subjects();
    // if (subjects) {
    //   console.log(subjects.get(subject_id));
    // }
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await pool.close();
  }
}

run();
